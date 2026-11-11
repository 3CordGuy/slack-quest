import { describe, expect, it } from "vitest";
import { STARTING_STATS, hexDistance } from "@gantt-quest/core";
import {
  CANNED_FILLS,
  STORY_FRAMES,
  applyXp,
  buildBible,
  clientView,
  createBattle,
  createWorld,
  currentActor,
  demandMet,
  describeBearing,
  findPath,
  generateMap,
  makeRng,
  newNpcRun,
  parseNpcOutput,
  poiById,
  reachable,
  requiredDoom,
  rollCheck,
  rollStartingStats,
  statPct,
  stepBattle,
  seedFromString,
  stepWorld,
  storyHints,
  tileAt,
  upgradeWorld,
  validateBible,
  validateFill,
  validateIntent,
  xpToNext,
  type BattleState,
  type Combatant,
  type HeroInit,
  type StoryBible,
  type WorldAction,
  type WorldEffect,
  type WorldEvent,
  type WorldState,
} from "./index";

const frame = STORY_FRAMES[0];
const fill = CANNED_FILLS.stolen_relic[0];

function heroInit(id: string, classId: string, weapon: string): HeroInit {
  return { id, name: id.toUpperCase(), classId, level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS[classId] }, bonus: {}, weapon };
}

/** Apply an action that must succeed; collect events and effects. */
function must(state: WorldState, action: WorldAction, sink?: { events: WorldEvent[]; effects: WorldEffect[] }): WorldState {
  const res = stepWorld(state, action);
  if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
  sink?.events.push(...res.events);
  sink?.effects.push(...res.effects);
  return res.state;
}

function startedWorld(seed = "test-seed"): WorldState {
  let s = createWorld("ABCD", seed);
  s = must(s, { type: "join", hero: heroInit("p1", "qa_paladin", "mace") });
  s = must(s, { type: "join", hero: heroInit("p2", "devops_mage", "staff") });
  s = must(s, { type: "ready", heroId: "p2", ready: true });
  s = must(s, { type: "start", heroId: "p1" });
  return must(s, { type: "begin", bible: buildBible(frame, fill) });
}

/** Teleport helper for tests: put every hero on a hex. */
function placeAll(s: WorldState, poiId: string): WorldState {
  const pos = poiById(s.map, poiId)!.pos;
  return { ...s, heroes: s.heroes.map((h) => ({ ...h, pos })) };
}

describe("rng and rollCheck", () => {
  it("is deterministic and resumable from its state", () => {
    const a = makeRng(42);
    const first = [a.next(), a.next(), a.next()];
    const b = makeRng(42);
    b.next();
    const resumed = makeRng(b.state());
    expect([resumed.next(), resumed.next()]).toEqual(first.slice(1));
  });

  it("guarantees focus rolls and reports perfect / fumble", () => {
    const sure = rollCheck(makeRng(1), { label: "x", pct: 0, count: 3, focus: 2 });
    expect(sure.rolls).toEqual([true, true, false]);
    expect(sure.successes).toBe(2);
    expect(rollCheck(makeRng(1), { label: "x", pct: 100, count: 4 }).perfect).toBe(true);
    expect(rollCheck(makeRng(1), { label: "x", pct: 0, count: 4 }).fumble).toBe(true);
  });

  it("lands near the stated percentage", () => {
    const rng = makeRng(7);
    let hits = 0;
    for (let i = 0; i < 4000; i++) hits += rollCheck(rng, { label: "x", pct: 70, count: 1 }).successes;
    expect(hits / 4000).toBeGreaterThan(0.67);
    expect(hits / 4000).toBeLessThan(0.73);
  });

  it("maps stats to a clamped percentage", () => {
    expect(statPct(4)).toBe(55);
    expect(statPct(9)).toBe(80);
    expect(statPct(40)).toBe(95);
    expect(statPct(-5)).toBe(20);
  });
});

describe("island generation", () => {
  it("is deterministic per seed and differs across seeds", () => {
    expect(generateMap("a")).toEqual(generateMap("a"));
    expect(generateMap("a")).not.toEqual(generateMap("b"));
  });

  it("always yields a playable island", () => {
    for (let i = 0; i < 40; i++) {
      const map = generateMap(`seed-${i}`);
      const landing = poiById(map, "landing")!;
      const lair = poiById(map, "lair")!;
      expect(lair.hidden).toBe(true);
      expect(hexDistance(landing.pos, lair.pos)).toBeGreaterThanOrEqual(5);
      const reach = reachable(map, landing.pos);
      for (const poi of map.pois) {
        expect(tileAt(map, poi.pos)!.biome).not.toBe("water");
        expect(reach.has(`${poi.pos.q},${poi.pos.r}`), `${poi.id} reachable on seed-${i}`).toBe(true);
      }
      const keys = new Set(map.pois.map((p) => `${p.pos.q},${p.pos.r}`));
      expect(keys.size).toBe(map.pois.length);
      // Sea at the rim: the island should be mostly, but not entirely, land.
      const water = map.tiles.filter((t) => t.biome === "water").length / map.tiles.length;
      expect(water).toBeGreaterThan(0.1);
      expect(water).toBeLessThan(0.6);
    }
  });

  it("charges terrain cost and refuses water", () => {
    const map = generateMap("cost");
    const landing = poiById(map, "landing")!.pos;
    const hut = poiById(map, "hut")!.pos;
    const route = findPath(map, landing, hut)!;
    expect(route.path.at(-1)).toEqual(hut);
    expect(route.cost).toBeGreaterThanOrEqual(route.path.length);
    expect(route.path.every((p) => tileAt(map, p)!.biome !== "water")).toBe(true);
    expect(findPath(map, landing, hut, 1)).toBeNull();
  });
});

describe("battle", () => {
  const fighter = (id: string, over: Partial<Combatant> = {}): Combatant => ({
    id, side: "hero", name: id, kind: "qa_paladin", level: 1, hp: 30, maxHp: 30,
    pct: { str: 100, vit: 100, agi: 100, dex: 100, int_stat: 100 },
    speed: 200, focus: 2, potions: 1, abilities: ["smite", "shield_wall", "cleave"], effects: [], down: false, ...over,
  });
  const setup = (heroes: Combatant[], enemyKinds: string[], seed = 3) =>
    createBattle({ heroes, enemyKinds, avgLevel: 1, poiId: "camp" }, makeRng(seed));

  it("orders by speed and stops on a hero turn", () => {
    const { state } = setup([fighter("h1")], ["bandit", "wolf"]);
    expect(state.order[0]).toBe("h1");
    expect(currentActor(state)!.id).toBe("h1");
    expect(state.xp).toBe(22);
  });

  it("rejects out-of-turn and unknown actions", () => {
    const { state } = setup([fighter("h1"), fighter("h2", { speed: 150 })], ["bandit"]);
    const rng = makeRng(1);
    expect(stepBattle(state, "h2", { type: "ability", ability: "smite" }, rng).ok).toBe(false);
    expect(stepBattle(state, "h1", { type: "ability", ability: "firebolt" }, rng).ok).toBe(false);
    expect(stepBattle(state, "h1", { type: "ability", ability: "smite", focus: 9 }, rng).ok).toBe(false);
    expect(stepBattle(state, "h1", { type: "ability", ability: "smite", target: "h2" }, rng).ok).toBe(false);
  });

  it("runs to victory, with perfect results applying effects", () => {
    let { state } = setup([fighter("h1")], ["bandit"]);
    const rng = makeRng(9);
    const first = stepBattle(state, "h1", { type: "ability", ability: "smite", target: "e0" }, rng);
    if (!first.ok) throw new Error(first.error);
    // 100% over 3 rolls is perfect: full damage (9 + level) and a stun.
    expect(first.events).toContainEqual(expect.objectContaining({ t: "hit", amount: 10, perfect: true }));
    expect(first.events).toContainEqual({ t: "effect", target: "e0", effect: "stunned", turns: 1 });
    expect(first.events).toContainEqual({ t: "skip", id: "e0", effect: "stunned" });
    state = first.state;
    const second = stepBattle(state, "h1", { type: "ability", ability: "smite", target: "e0" }, rng);
    if (!second.ok) throw new Error(second.error);
    expect(second.state.status).toBe("victory");
    expect(second.events.at(-1)).toEqual({ t: "end", status: "victory" });
    expect(stepBattle(second.state, "h1", { type: "potion" }, rng).ok).toBe(false);
  });

  it("ends in defeat when every hero is down, and enemies act without a client", () => {
    const { state, events } = setup([fighter("h1", { hp: 1, speed: 0, pct: { str: 0 } })], ["wolf", "wolf", "wolf"], 5);
    // Enemies were faster, so they have already acted by the time createBattle returns.
    expect(events.some((e) => e.t === "check")).toBe(true);
    let s: BattleState = state;
    const rng = makeRng(11);
    for (let i = 0; i < 30 && s.status === "active"; i++) {
      const r = stepBattle(s, "h1", { type: "ability", ability: "smite" }, rng);
      if (!r.ok) throw new Error(r.error);
      s = r.state;
    }
    expect(s.status).toBe("defeat");
  });

  it("spends focus, heals with a potion, and can flee a normal fight but not a boss", () => {
    const { state } = setup([fighter("h1", { hp: 10 })], ["bandit"]);
    const rng = makeRng(2);
    const hit = stepBattle(state, "h1", { type: "ability", ability: "cleave", focus: 2 }, rng);
    if (!hit.ok) throw new Error(hit.error);
    expect(hit.state.combatants[0].focus).toBe(0);
    const pot = stepBattle(state, "h1", { type: "potion" }, rng);
    if (!pot.ok) throw new Error(pot.error);
    expect(pot.events[0]).toEqual({ t: "heal", actor: "h1", target: "h1", amount: 12, ability: "Potion" });
    const flee = stepBattle(state, "h1", { type: "flee" }, rng);
    expect(flee.ok && flee.state.status).toBe("fled");
    const boss = setup([fighter("h1")], ["villain"]);
    expect(stepBattle(boss.state, "h1", { type: "flee" }, rng).ok).toBe(false);
  });

  it("scales a boss with party size", () => {
    const solo = setup([fighter("h1")], ["villain"]).state.combatants.find((c) => c.side === "enemy")!;
    const trio = setup([fighter("h1"), fighter("h2"), fighter("h3")], ["villain"]).state.combatants.find((c) => c.side === "enemy")!;
    expect(trio.maxHp).toBeGreaterThan(solo.maxHp);
  });
});

describe("progression", () => {
  it("rolls starting stats around the class baseline", () => {
    const rng = makeRng(5);
    for (let i = 0; i < 50; i++) {
      const s = rollStartingStats(rng, "qa_paladin");
      expect(s.str).toBeGreaterThanOrEqual(8);
      expect(s.str).toBeLessThanOrEqual(11);
    }
  });

  it("levels up with class auto-allocation and a free point", () => {
    const p = { classId: "qa_paladin", level: 1, xp: 0, stats: { ...STARTING_STATS.qa_paladin }, unspent: 0 };
    const out = applyXp(p, xpToNext(1) + xpToNext(2) + 5);
    expect(out.level).toBe(3);
    expect(out.xp).toBe(5);
    expect(out.levelsGained).toBe(2);
    expect(out.unspent).toBe(2);
    expect(out.stats.str).toBe(p.stats.str + 2);
    expect(out.stats.vit).toBe(p.stats.vit + 2);
    expect(p.stats.str).toBe(STARTING_STATS.qa_paladin.str);
  });
});

describe("story bible", () => {
  it("accepts every canned fill and builds a completable bible", () => {
    const map = generateMap("bible");
    for (const f of CANNED_FILLS.stolen_relic) {
      expect(validateFill(f)).not.toBeNull();
      expect(validateBible(buildBible(frame, f), map)).toEqual([]);
    }
  });

  it("gives each voyage its own seeded flavour", () => {
    const hintsFor = (seed: string) => storyHints(makeRng(seedFromString(seed)));
    expect(hintsFor("a")).toEqual(hintsFor("a"));
    const many = Array.from({ length: 40 }, (_, i) => hintsFor(`voyage-${i}`));
    for (const h of many) {
      const { island, villain, islander } = h.initials;
      expect(new Set([island, villain, islander]).size).toBe(3);
    }
    // Nearly every voyage should differ from every other in the combination it gets.
    const combos = new Set(many.map((h) => `${h.relic}|${h.villain}|${h.island}|${h.initials.island}`));
    expect(combos.size).toBeGreaterThanOrEqual(38);
    expect(new Set(many.map((h) => h.relic)).size).toBeGreaterThanOrEqual(8);
  });

  it("rejects malformed model output", () => {
    expect(validateFill(null)).toBeNull();
    expect(validateFill("a story")).toBeNull();
    expect(validateFill({ ...fill, villain_name: 7 })).toBeNull();
    expect(validateFill({ ...fill, title: "" })).toBeNull();
    expect(validateFill({ ...fill, premise: "x".repeat(2000) })).toBeNull();
    expect(validateFill({ ...fill, npc_knowledge: [] })).toBeNull();
    const { relic_name: _dropped, ...missing } = fill;
    expect(validateFill(missing)).toBeNull();
  });

  it("reports a bible that cannot be completed", () => {
    const map = generateMap("bible");
    const bible = buildBible(frame, fill);
    bible.objectives.push({ id: "ghost", text: "?", fact: "defeated:nowhere" });
    bible.npcs[0].poi = "atlantis";
    const problems = validateBible(bible, map);
    expect(problems.some((p) => p.includes("nowhere"))).toBe(true);
    expect(problems.some((p) => p.includes("atlantis"))).toBe(true);
  });
});

describe("npc output and intent validation", () => {
  const sheet = buildBible(frame, fill).npcs[0];
  const met = { demandMet: true };

  it("parses objects, JSON strings and fenced JSON; rejects junk", () => {
    expect(parseNpcOutput({ say: " hi  there " })).toEqual({ say: "hi there", intent: null, attitudeDelta: 0 });
    expect(parseNpcOutput('```json\n{"say":"hi","attitude_delta":5}\n```')).toEqual({ say: "hi", intent: null, attitudeDelta: 1 });
    expect(parseNpcOutput('Sure! {"say":"ok","intent":{"verb":"give_item","args":{"item":"charm"}}}')!.intent).toEqual({
      verb: "give_item",
      args: { item: "charm" },
    });
    expect(parseNpcOutput("I am not JSON")).toBeNull();
    expect(parseNpcOutput({ intent: { verb: "give_item" } })).toBeNull();
    expect(parseNpcOutput({ say: "x".repeat(5000) })!.say.length).toBe(600);
  });

  it("refuses everything the model might invent", () => {
    const run = newNpcRun();
    const bad = [
      { verb: "give_gold", args: { amount: 1000 } },
      { verb: "give_item", args: { item: "1000 gold" } },
      { verb: "give_item", args: { item: "tidewatch_lantern" } },
      { verb: "give_item", args: {} },
      { verb: "reveal_location", args: { poi: "treasure_vault" } },
      { verb: "set_fact", args: { fact: "defeated:lair" } },
      { verb: "__proto__", args: {} },
    ];
    for (const intent of bad) expect(validateIntent(sheet, run, intent, met).ok, JSON.stringify(intent)).toBe(false);
  });

  it("gates persuasion-locked capabilities, and each fires once", () => {
    const run = newNpcRun();
    const give = { verb: "give_item", args: { item: "charm" } };
    expect(validateIntent(sheet, run, give, met).ok).toBe(false);
    run.persuaded = true;
    expect(validateIntent(sheet, run, give, met).ok).toBe(true);
    run.used.push("give_charm");
    expect(validateIntent(sheet, run, give, met).ok).toBe(false);
    const reveal = { verb: "reveal_location", args: { poi: "lair" } };
    expect(validateIntent(sheet, newNpcRun(), reveal, met).ok).toBe(true);
    expect(validateIntent(sheet, { ...newNpcRun(), hostile: true }, reveal, met).ok).toBe(false);
    // The lair is only given up once the NPC's demand has been met.
    expect(validateIntent(sheet, newNpcRun(), reveal, { demandMet: false }).ok).toBe(false);
    const fight = { verb: "start_combat", args: {} };
    expect(validateIntent(sheet, newNpcRun(), fight, met).ok).toBe(false);
    expect(validateIntent(sheet, { ...newNpcRun(), attitude: -1 }, fight, met).ok).toBe(true);
  });
});

describe("world reducer", () => {
  it("runs the lobby rules", () => {
    let s = createWorld("ABCD", "lobby");
    s = must(s, { type: "join", hero: heroInit("p1", "qa_paladin", "mace") });
    s = must(s, { type: "join", hero: heroInit("p2", "devops_mage", "staff") });
    expect(s.hostId).toBe("p1");
    expect(stepWorld(s, { type: "start", heroId: "p2" }).ok).toBe(false);
    expect(stepWorld(s, { type: "start", heroId: "p1" }).ok).toBe(false);
    s = must(s, { type: "ready", heroId: "p2", ready: true });
    const sink = { events: [] as WorldEvent[], effects: [] as WorldEffect[] };
    s = must(s, { type: "start", heroId: "p1" }, sink);
    expect(s.phase).toBe("generating");
    expect(sink.effects).toEqual([{ kind: "story_gen" }]);
    expect(stepWorld(s, { type: "join", hero: heroInit("p3", "refactor_rogue", "daggers") }).ok).toBe(false);
    // Rejoining an existing hero is a no-op, not an error.
    expect(stepWorld(s, { type: "join", hero: heroInit("p2", "devops_mage", "staff") }).ok).toBe(true);
  });

  it("is deterministic: same seed and actions give the same state", () => {
    expect(startedWorld("same")).toEqual(startedWorld("same"));
  });

  it("enforces turn order, movement points and one action per turn", () => {
    let s = startedWorld();
    const doomAtStart = s.doom;
    const turn = s.turn!;
    const other = s.heroes.find((h) => h.id !== turn.heroId)!;
    expect(turn.mp).toBeGreaterThanOrEqual(2);
    expect(turn.mp).toBeLessThanOrEqual(6);
    expect(stepWorld(s, { type: "end_turn", heroId: other.id }).ok).toBe(false);
    const me = s.heroes.find((h) => h.id === turn.heroId)!;
    const steps = [...reachable(s.map, me.pos, turn.mp).values()].filter((r) => r.cost > 0);
    const target = steps.sort((a, b) => b.cost - a.cost)[0];
    expect(stepWorld(s, { type: "move", heroId: other.id, to: target.pos }).ok).toBe(false);
    s = must(s, { type: "move", heroId: me.id, to: target.pos });
    expect(s.turn!.mp).toBe(turn.mp - target.cost);
    expect(s.heroes.find((h) => h.id === me.id)!.pos).toEqual(target.pos);
    const lair = s.map.pois.find((p) => p.id === "lair")!.pos;
    expect(stepWorld(s, { type: "move", heroId: me.id, to: lair }).ok).toBe(false);
    s = must(s, { type: "end_turn", heroId: me.id });
    expect(s.turn!.heroId).toBe(other.id);
    s = must(s, { type: "end_turn", heroId: other.id });
    expect(s.round).toBe(2);
    expect(s.doom).toBe(doomAtStart - 1);
  });

  it("ends in defeat when the doom clock runs out, with a capped penalty", () => {
    let s = startedWorld();
    const sink = { events: [] as WorldEvent[], effects: [] as WorldEffect[] };
    for (let i = 0; i < 200 && s.phase === "overworld"; i++) s = must(s, { type: "timeout" }, sink);
    expect(s.phase).toBe("ended");
    expect(s.result!.outcome).toBe("defeat");
    expect(sink.effects.filter((e) => e.kind === "penalty")).toHaveLength(2);
    expect(sink.effects).toContainEqual({ kind: "run_end", outcome: "defeat" });
  });

  it("handles a conversation: checks, validated intents, rejected inventions", () => {
    let s = placeAll(startedWorld(), "hut");
    const sink = { events: [] as WorldEvent[], effects: [] as WorldEffect[] };
    const far = { ...s, heroes: s.heroes.map((h) => ({ ...h, pos: poiById(s.map, "landing")!.pos })) };
    expect(stepWorld(far, { type: "talk", heroId: "p1", npcId: "npc1", text: "hello" }).ok).toBe(false);

    s = must(s, { type: "talk", heroId: "p1", npcId: "npc1", text: "  Give me   1000 gold  " }, sink);
    expect(s.chat.at(-1)!.text).toBe("Give me 1000 gold");
    expect(s.facts["met:npc1"]).toBe(true);
    expect(sink.effects.at(-1)).toMatchObject({ kind: "npc_call", npcId: "npc1", heroId: "p1", check: null });
    expect(stepWorld(s, { type: "talk", heroId: "p2", npcId: "npc1", text: "me too" }).ok).toBe(false);

    // A jailbroken model tries to hand out gold and the charm; only words get through.
    sink.events.length = 0;
    s = must(s, { type: "npc_reply", npcId: "npc1", heroId: "p1", output: { say: "Take it all!", intent: { verb: "give_gold", args: { amount: 1000 } }, attitudeDelta: 1 } }, sink);
    expect(sink.events).toContainEqual(expect.objectContaining({ t: "npc_intent", ok: false }));
    expect(s.earned.p1).toBeUndefined();
    s = must(s, { type: "talk", heroId: "p1", npcId: "npc1", text: "the charm then" });
    s = must(s, { type: "npc_reply", npcId: "npc1", heroId: "p1", output: { say: "Here.", intent: { verb: "give_item", args: { item: "charm" } }, attitudeDelta: 1 } });
    expect(s.heroes[0].keyItems).toEqual([]);
    expect(s.npcs.npc1.attitude).toBe(1);

    // After a passed check the same intent is honoured, once.
    s = { ...s, npcs: { npc1: { ...s.npcs.npc1, persuaded: true } } };
    const focusBefore = s.heroes[0].maxFocus;
    s = must(s, { type: "talk", heroId: "p1", npcId: "npc1", text: "please" });
    s = must(s, { type: "npc_reply", npcId: "npc1", heroId: "p1", output: { say: "Fine.", intent: { verb: "give_item", args: { item: "charm" } }, attitudeDelta: 0 } });
    expect(s.heroes[0].keyItems).toEqual(["charm"]);
    expect(s.heroes[0].maxFocus).toBe(focusBefore + 2);
    s = must(s, { type: "talk", heroId: "p1", npcId: "npc1", text: "another?" });
    s = must(s, { type: "npc_reply", npcId: "npc1", heroId: "p1", output: { say: "No.", intent: { verb: "give_item", args: { item: "charm" } }, attitudeDelta: 0 } });
    expect(s.heroes[0].keyItems).toEqual(["charm"]);

    // The NPC asked for the camp to be cleared; until then it cannot reveal the lair, whatever the model says.
    expect(clientView(s, "p1").story!.demand).toEqual({ npcName: fill.npc_name, text: frame.demands[0].text, done: false });
    const tell: WorldAction = { type: "npc_reply", npcId: "npc1", heroId: "p2", output: { say: "East.", intent: { verb: "reveal_location", args: { poi: "lair" } }, attitudeDelta: 0 } };
    s = must(s, { type: "talk", heroId: "p2", npcId: "npc1", text: "just tell us" });
    s = must(s, tell);
    expect(poiById(s.map, "lair")!.hidden).toBe(true);
    s = { ...s, facts: { ...s.facts, "defeated:camp": true } };
    expect(clientView(s, "p1").story!.demand!.done).toBe(true);

    // Revealing the lair completes an objective and pays XP to everyone.
    sink.events.length = 0;
    s = must(s, { type: "talk", heroId: "p2", npcId: "npc1", text: "where is the lair?" });
    s = must(s, { type: "npc_reply", npcId: "npc1", heroId: "p2", output: { say: "East.", intent: { verb: "reveal_location", args: { poi: "lair" } }, attitudeDelta: 0 } }, sink);
    expect(poiById(s.map, "lair")!.hidden).toBe(false);
    expect(sink.events).toContainEqual({ t: "objective", id: "locate" });
    expect(s.earned.p1.xp).toBe(15);
    expect(s.earned.p2.xp).toBe(15);
  });

  it("rolls persuasion with focus and limits attempts", () => {
    let s = placeAll(startedWorld(), "hut");
    const sink = { events: [] as WorldEvent[], effects: [] as WorldEffect[] };
    s = must(s, { type: "talk", heroId: "p2", npcId: "npc1", text: "trust me", persuade: true, focus: 2 }, sink);
    const call = sink.effects.find((e) => e.kind === "npc_call")!;
    expect(call.kind === "npc_call" && call.check!.successes).toBeGreaterThanOrEqual(2);
    expect(s.npcs.npc1.persuaded).toBe(true);
    expect(s.heroes.find((h) => h.id === "p2")!.focus).toBe(0);
    const reply: WorldAction = { type: "npc_reply", npcId: "npc1", heroId: "p2", output: { say: "Hm.", intent: null, attitudeDelta: 0 } };
    s = must(s, reply);
    s = must(s, { type: "talk", heroId: "p2", npcId: "npc1", text: "again", persuade: true });
    s = must(s, reply);
    expect(stepWorld(s, { type: "talk", heroId: "p2", npcId: "npc1", text: "third", persuade: true }).ok).toBe(false);
  });

  it("lets an NPC start a fight, then refuses to talk", () => {
    let s = placeAll(startedWorld(), "hut");
    const threat: WorldAction = { type: "npc_reply", npcId: "npc1", heroId: "p1", output: { say: "Guards!", intent: { verb: "start_combat", args: {} }, attitudeDelta: -1 } };
    // The first bad exchange only sours the NPC; it takes a second to start a fight.
    s = must(s, { type: "talk", heroId: "p1", npcId: "npc1", text: "hand it over or else" });
    s = must(s, threat);
    expect(s.phase).toBe("overworld");
    expect(s.npcs.npc1.attitude).toBe(-1);
    s = must(s, { type: "talk", heroId: "p1", npcId: "npc1", text: "I said hand it over" });
    s = must(s, threat);
    expect(s.phase).toBe("battle");
    expect(s.battle!.npcId).toBe("npc1");
    expect(s.npcs.npc1.hostile).toBe(true);
    expect(stepWorld(s, { type: "talk", heroId: "p1", npcId: "npc1", text: "sorry" }).ok).toBe(false);
  });

  it("plays a fight at the lair through to victory, rewards and the ending", () => {
    let s = placeAll(startedWorld("win"), "lair");
    // Make the party strong enough that the outcome does not depend on the seed.
    s = { ...s, heroes: s.heroes.map((h) => ({ ...h, base: { str: 12, int_stat: 12, vit: 12, agi: 12, dex: 12 }, hp: 200, maxHp: 200 })) };
    const sink = { events: [] as WorldEvent[], effects: [] as WorldEffect[] };
    s = must(s, { type: "interact", heroId: s.turn!.heroId }, sink);
    expect(s.phase).toBe("battle");
    expect(s.battle!.combatants.find((c) => c.kind === "villain")!.name).toBe(fill.villain_name);
    for (let i = 0; i < 100 && s.phase === "battle"; i++) s = must(s, { type: "timeout" }, sink);
    expect(s.phase).toBe("ended");
    expect(s.result!.outcome).toBe("victory");
    expect(s.facts["defeated:lair"]).toBe(true);
    for (const id of ["p1", "p2"]) {
      expect(s.earned[id].xp).toBeGreaterThanOrEqual(54 + 50);
      expect(s.earned[id].gold).toBeGreaterThan(30);
      expect(s.earned[id].items.length).toBeGreaterThanOrEqual(2);
    }
    // Enough XP to level: the hero and the D1 effect must agree.
    expect(s.heroes[0].level).toBeGreaterThan(1);
    const granted = sink.effects.filter((e) => e.kind === "grant" && e.heroId === "p1").reduce((a, e) => a + (e.kind === "grant" ? e.xp : 0), 0);
    expect(granted).toBe(s.earned.p1.xp);
    expect(sink.effects).toContainEqual({ kind: "epilogue" });
    s = must(s, { type: "epilogue", text: " And so it ended. " });
    expect(s.result!.epilogue).toBe("And so it ended.");
  });

  it("reveals the hidden lair when a hero walks next to it", () => {
    let s = startedWorld("walk");
    const lair = poiById(s.map, "lair")!.pos;
    const me = s.turn!.heroId;
    const next = [...reachable(s.map, lair, 8).values()].find((r) => hexDistance(r.pos, lair) === 2)!;
    s = { ...s, heroes: s.heroes.map((h) => (h.id === me ? { ...h, pos: next.pos } : h)), turn: { ...s.turn!, mp: 8 } };
    const adjacent = [...reachable(s.map, next.pos, 8).values()].find((r) => r.cost > 0 && hexDistance(r.pos, lair) === 1)!;
    s = must(s, { type: "move", heroId: me, to: adjacent.pos });
    expect(poiById(s.map, "lair")!.hidden).toBe(false);
    expect(s.facts["revealed:lair"]).toBe(true);
  });
});

describe("story fits the island", () => {
  it("gives the doom clock room for the walk the story needs", () => {
    for (let i = 0; i < 30; i++) {
      const s = startedWorld(`doom-${i}`);
      const stops = ["landing", "hut", "camp", "hut", "lair"].map((id) => poiById(s.map, id)!.pos);
      let cost = 0;
      for (let j = 1; j < stops.length; j++) cost += findPath(s.map, stops[j - 1], stops[j])!.cost;
      // Even at the minimum of 2 movement a turn, plus slack, the party is not asked for the impossible.
      expect(s.doom).toBeGreaterThanOrEqual(frame.doomRounds);
      expect(s.doom).toBeGreaterThanOrEqual(requiredDoom(s.map, s.bible!, s.heroes));
      expect(s.doom, `seed doom-${i}`).toBeGreaterThanOrEqual(Math.ceil(cost / 4.4) + 4);
    }
  });

  it("needs fewer days when the NPC only wants persuading", () => {
    const s = startedWorld("demand");
    const trust = buildBible(frame, fill, frame.demands[1]);
    expect(requiredDoom(s.map, trust, s.heroes)).toBeLessThanOrEqual(requiredDoom(s.map, s.bible!, s.heroes));
    expect(validateBible(trust, s.map)).toEqual([]);
    expect(demandMet(trust, {}, false)).toBe(false);
    expect(demandMet(trust, {}, true)).toBe(true);
    expect(demandMet(s.bible!, { "defeated:camp": true }, false)).toBe(true);
  });

  it("upgrades a story saved before demands existed", () => {
    const s = placeAll(startedWorld("legacy"), "hut");
    const saved = JSON.parse(JSON.stringify(s)) as WorldState;
    delete (saved.bible as Partial<StoryBible>).demand;
    let old = upgradeWorld(saved);
    expect(demandMet(old.bible!, {}, false)).toBe(true);
    old = must(old, { type: "talk", heroId: "p1", npcId: "npc1", text: "hello" });
    expect(clientView(old, "p1").story!.demand).toBeNull();
  });

  it("rejects a demand the island cannot satisfy", () => {
    const s = startedWorld("demand");
    const bad = buildBible(frame, fill, { id: "x", text: "slay the dragon", fact: "defeated:dragon_roost" });
    expect(validateBible(bad, s.map).some((p) => p.includes("demand"))).toBe(true);
  });

  it("describes bearings the way the map is drawn", () => {
    expect(describeBearing({ q: 0, r: 0 }, { q: 3, r: 0 })).toBe("about 3 hexes to the east");
    expect(describeBearing({ q: 0, r: 4 }, { q: 2, r: 0 })).toBe("about 4 hexes to the north");
    expect(describeBearing({ q: 2, r: 0 }, { q: 0, r: 4 })).toBe("about 4 hexes to the south");
    expect(describeBearing({ q: 0, r: 0 }, { q: 0, r: 1 })).toBe("about 1 hex to the south-east");
    expect(describeBearing({ q: 1, r: 1 }, { q: 1, r: 1 })).toBe("right here");
  });
});

describe("client view", () => {
  it("hides the lair, NPC secrets and the RNG", () => {
    const s = startedWorld();
    const view = clientView(s, "p1");
    const json = JSON.stringify(view);
    expect(view.map.pois.some((p) => p.id === "lair")).toBe(false);
    expect(view.story!.poiNames.lair).toBeUndefined();
    expect(json).not.toContain(fill.npc_secret);
    expect(json).not.toContain(fill.npc_knowledge[1]);
    expect(json).not.toContain('"capabilities"');
    expect("rng" in view).toBe(false);
    expect("seed" in view).toBe(false);
    expect(view.you).toBe("p1");
    expect(view.story!.objectives.map((o) => o.done)).toEqual([false, false, false]);
    // The NPC's ask is not shown until the party has actually met them.
    expect(view.story!.demand).toBeNull();
    // The source state is untouched.
    expect(poiById(s.map, "lair")).toBeDefined();
  });
});
