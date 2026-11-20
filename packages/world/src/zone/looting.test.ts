// Looting (loot.ts, spoils.ts): nothing is put in anyone's pack but XP. The fallen lie where they fell, a chest
// stands open, a cleared place's spoils are heaped on the ground, and each hero walks up and takes from them.
// A body and a chest are everyone's, first come first served: one lot of things, the same for all who look, and
// what one takes is gone for the rest. The spoils are each hero's own share.
// And what is in each of them: the tables by what an enemy was, a chest's pay, the lodestones of a place.

import { describe, expect, it } from "vitest";
import { at, fails, flatBoard, must, standEnemy, standHero, unit } from "../test/zoneBoard";
import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import { rollItem } from "../gear";
import { SPOIL_STONES, STONE_MODS, cleanStone, rollStone, spoilStones } from "../lodestone";
import { makeRng } from "../rng";
import { ZONE_MODS } from "./mods";
import { ITEM_AP, AP_TURN } from "./kit";
import { CHEST_PAY, SPOILS_ID, bountyPay, leaveBody, lootFor, unlooted } from "./loot";
import { BOSS_LOOT, ENEMY_FAMILY, FAMILY_LOOT, rollBody, rollChest, rollSpoils, type Family } from "./spoils";
import { stepZone, zoneView } from "./zone";
import type { LootItem, LootSpot, Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneState } from "./types";

// ---------- helpers ----------


/** A flat, open board with nothing on it, the enemy's AI off. */
const board = (options: Partial<ZoneState["options"]> = {}): ZoneState => flatBoard({ rng: 777, start: at(1, 1), options: { party: 2, ...options }, flags: { aiOff: true } });
/** A hero of a player's own, or (`controller`) a stand-in that player plays. */
const hero = (state: ZoneState, id: string, pos: HexPos, controller?: string, level = 2): Unit =>
  standHero(state, id, pos, { classId: "qa_paladin", level, armor: 0, power: 0, abilities: ["bash"], items: { healing: 1 }, controller });
const enemy = (state: ZoneState, kind: string, pos: HexPos, group = "g1", level = 1): Unit => standEnemy(state, kind, pos, group, { level });
const spotOf = (state: ZoneState, id: string): LootSpot => state.loot!.find((s) => s.id === id)!;
const startFight = (state: ZoneState, events: ZoneEvent[] = []) => must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
/** Every enemy in the fight falls at once. */
const win = (state: ZoneState, events: ZoneEvent[] = [], effects: ZoneEffect[] = []) => must(state, { type: "dev", by: "ann", dev: { op: "end_fight" } }, events, effects);
const look = (id: string, spot: string, by = id): ZoneAction => ({ type: "loot", by, unit: id, spot });
/** Take all of it, or (`index`) the thing at a place in a share of one's own. */
const take = (id: string, spot: string, index?: number, by = id): ZoneAction => ({ type: "take", by, unit: id, spot, ...(index === undefined ? {} : { index }) });
/** Take one thing, named by its own number. */
const takeOne = (id: string, spot: string, uid: number): ZoneAction => ({ type: "take", by: id, unit: id, spot, uid });
/** The things themselves, without the numbers they were given where they lay. */
const bare = (items: LootItem[]): LootItem[] => items.map(({ uid: _uid, ...item }) => item as LootItem);

/** Everything in a list of loot, or in the grants a taking made, counted up the same way: so one can be held against the other. */
interface Tally {
  gold: number;
  res: Record<string, number>;
  use: Record<string, number>;
  gear: string[];
  stones: string[];
  blueprints: string[];
  furnishings: string[];
}
const blank = (): Tally => ({ gold: 0, res: {}, use: {}, gear: [], stones: [], blueprints: [], furnishings: [] });
function tallyItems(items: LootItem[]): Tally {
  const t = blank();
  for (const i of items) {
    if (i.t === "gold") t.gold += i.n;
    else if (i.t === "res") t.res[i.kind] = (t.res[i.kind] ?? 0) + i.n;
    else if (i.t === "use") t.use[i.kind] = (t.use[i.kind] ?? 0) + i.n;
    else if (i.t === "gear") t.gear.push(i.item.name);
    else if (i.t === "stone") t.stones.push(i.stone.join("+"));
    else if (i.t === "blueprint") t.blueprints.push(i.id);
    else t.furnishings.push(i.grant.defId);
  }
  for (const list of [t.gear, t.stones, t.blueprints, t.furnishings]) list.sort();
  return t;
}
function tallyGrants(effects: ZoneEffect[]): Tally {
  const t = blank();
  for (const e of effects) {
    t.gold += e.gold ?? 0;
    for (const [kind, n] of Object.entries(e.resources)) t.res[kind] = (t.res[kind] ?? 0) + (n ?? 0);
    for (const [kind, n] of Object.entries(e.items ?? {})) t.use[kind] = (t.use[kind] ?? 0) + (n ?? 0);
    if (e.item) t.gear.push(e.item.name);
    if (e.stone) t.stones.push(e.stone.join("+"));
    if (e.blueprint) t.blueprints.push(e.blueprint);
    if (e.furnishing) t.furnishings.push(e.furnishing.defId);
  }
  for (const list of [t.gear, t.stones, t.blueprints, t.furnishings]) list.sort();
  return t;
}

// ---------- the fallen ----------

describe("the fallen", () => {
  it("lie where they fell once the fight is won, each to be searched: not while it is still going on, and never a training dummy", () => {
    let state = board();
    hero(state, "ann", at(4, 6));
    const bandit = enemy(state, "bandit", at(6, 6), "g1", 3);
    const wolf = enemy(state, "wolf", at(7, 4));
    const dummy = enemy(state, "dummy", at(7, 8));
    state = startFight(state);
    // The bandit falls, and the fight goes on: its body is still one of the fight's own, and nothing is there to search.
    Object.assign(unit(state, bandit.id), { hp: 0, down: true });
    state = must(state, { type: "timeout" });
    expect(state.encounter).not.toBeNull();
    expect(state.units.some((u) => u.id === bandit.id)).toBe(true);
    expect(state.loot ?? []).toEqual([]);
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = win(state, events, effects);
    expect(events).toContainEqual({ t: "fight_end", outcome: "victory" });
    // The fight pays its XP, and that is all it pays.
    expect(effects).toEqual([{ type: "grant", heroId: "ann", xp: ENEMIES.bandit.xp + ENEMIES.wolf.xp + ENEMIES.dummy.xp, resources: {} }]);
    expect(state.units.filter((u) => u.side === "enemy")).toEqual([]);
    expect(state.loot).toEqual([
      { id: bandit.id, kind: "body", name: ENEMIES.bandit.name, pos: at(6, 6), unit: "bandit", level: 3, loot: {} },
      { id: wolf.id, kind: "body", name: ENEMIES.wolf.name, pos: at(7, 4), unit: "wolf", level: 1, loot: {} },
    ]);
    expect(state.loot!.some((s) => s.id === dummy.id)).toBe(false);
  });

  it("stay dead when the party gets away: a body for each that fell, and the living go home whole", () => {
    let state = board();
    hero(state, "ann", at(2, 6));
    const dead = enemy(state, "bandit", at(6, 6));
    const alive = enemy(state, "bandit", at(8, 6));
    state = startFight(state);
    while (state.encounter!.acting[0] !== "ann") state = must(state, { type: "timeout" });
    Object.assign(unit(state, dead.id), { hp: 0, down: true });
    unit(state, alive.id).hp = 3;
    unit(state, alive.id).pos = at(9, 7);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "common", by: "ann", unit: "ann", what: "flee" }, events);
    expect(events).toContainEqual({ t: "fight_end", outcome: "fled" });
    expect(state.encounter).toBeNull();
    expect(state.units.some((u) => u.id === dead.id)).toBe(false);
    expect(state.loot).toEqual([{ id: dead.id, kind: "body", name: ENEMIES.bandit.name, pos: at(6, 6), unit: "bandit", level: 1, loot: {} }]);
    expect(unit(state, alive.id)).toMatchObject({ down: false, hp: ENEMIES.bandit.hp, pos: at(8, 6) });
    expect(state.groups.g1).toEqual({ alerted: false });
    // Nothing was won, so nothing was paid; but the body is there for whoever comes back for it.
    unit(state, "ann").pos = at(5, 6);
    expect(must(state, look("ann", dead.id)).loot![0].shared).toBeDefined();
  });

  it("leave nothing if they were lost to a pit, or were something a hero called", () => {
    const state = board();
    const bandit = enemy(state, "bandit", at(6, 6));
    leaveBody(state, { ...bandit, down: true, lost: "lava" });
    leaveBody(state, { ...bandit, down: true, side: "hero", kind: "sea_turtle", summon: { by: "ann" } });
    leaveBody(state, { ...bandit, down: true, kind: "dummy" });
    expect(state.loot ?? []).toEqual([]);
    leaveBody(state, { ...bandit, down: true });
    expect(state.loot).toHaveLength(1);
  });
});

// ---------- looking and taking ----------

describe("searching", () => {
  /** A bandit's body at at(6, 6) after a won fight; Ann and Bo (players' own) and Cy (a stand-in of Ann's) beside it, Di far off. */
  function body(rng = 777, options: Partial<ZoneState["options"]> = {}) {
    let state = board(options);
    hero(state, "ann", at(5, 6));
    hero(state, "bo", at(6, 5));
    hero(state, "cy", at(6, 7), "ann");
    hero(state, "di", at(14, 10));
    const bandit = enemy(state, "bandit", at(6, 6));
    state = win(startFight(state));
    state.rng = rng;
    expect(state.loot!.map((s) => s.id)).toEqual([bandit.id]);
    return { state, spot: bandit.id };
  }
  /** The same, with a known lot of things already found on it: each with its own number, as a look would have given them. */
  function stocked() {
    const made = body();
    const [sword, helm] = [rollItem(makeRng(1), "qa_paladin", 0.5, 2), rollItem(makeRng(2), "qa_paladin", 0.5, 2)];
    const things: LootItem[] = [
      { t: "gold", n: 7 },
      { t: "res", kind: "bone", n: 2 },
      { t: "res", kind: "iron", n: 1 },
      { t: "use", kind: "healing", n: 1 },
      { t: "use", kind: "fire", n: 2 },
      { t: "gear", item: sword },
      { t: "gear", item: helm },
      { t: "stone", stone: ["hardy"] },
      { t: "stone", stone: [] },
      { t: "blueprint", id: "map_table" },
      { t: "furnishing", grant: { defId: "rug", label: "Rug" } },
    ];
    const items = things.map((item, i) => ({ ...item, uid: i + 1 }) as LootItem);
    spotOf(made.state, made.spot).shared = structuredClone(items);
    return { ...made, items, sword, helm };
  }

  it("looking rolls what is on a body once, for everyone, the first time anyone looks: and never again", () => {
    let { state, spot } = body();
    expect(spotOf(state, spot).shared).toBeUndefined();
    const events: ZoneEvent[] = [];
    state = must(state, look("ann", spot), events);
    expect(events).toEqual([{ t: "looked", id: "ann", spot }]);
    const found = spotOf(state, spot).shared!;
    expect(Array.isArray(found)).toBe(true);
    // It is nobody's share: there is the one lot, and each thing in it has a number of its own.
    expect(spotOf(state, spot).loot).toEqual({});
    expect(found.every((item) => Number.isInteger(item.uid))).toBe(true);
    expect(new Set(found.map((item) => item.uid)).size).toBe(found.length);
    // Bo looks, with the dice anywhere else: the same things lie there. So too when Ann looks again.
    for (const id of ["bo", "ann"]) {
      const again = must({ ...state, rng: 31337 }, look(id, spot));
      expect(spotOf(again, spot).shared).toEqual(found);
      expect(spotOf(again, spot).loot).toEqual({});
    }
    // Nothing was put in anyone's pack by looking.
    expect(stepZone(state, look("ann", spot))).toMatchObject({ ok: true, effects: [] });
  });

  it("two heroes find the same things on a body, whichever of them looks first: one lot, not one each", () => {
    let some = 0;
    for (let seed = 1; seed <= 30; seed++) {
      const { state, spot } = body(seed * 101);
      const annFirst = must(must(state, look("ann", spot)), look("bo", spot));
      const boFirst = must(must(state, look("bo", spot)), look("ann", spot));
      const found = spotOf(annFirst, spot).shared!;
      expect(spotOf(boFirst, spot).shared).toEqual(found);
      // What each is sent of it is the same, to the last thing.
      expect(zoneView(annFirst, "ann").loot).toEqual(zoneView(annFirst, "bo").loot);
      // And it is what one hero's share was: a single roll of the bandit's table, whoever is in the party (a piece of gear in it for one of them, as the dice have it).
      const rng = makeRng(seed * 101);
      const whose = rng.pick(state.units.filter((u) => u.side === "hero" && !u.controller));
      expect(bare(found)).toEqual(rollBody(rng, "bandit", 1, { classId: whose.kind, level: whose.level }, state.options));
      if (found.length > 0) some++;
    }
    expect(some).toBeGreaterThan(15);
  });

  it("what one hero takes is gone for the other: they no longer see it, and cannot take it", () => {
    const { state, spot, items } = stocked();
    const bone = items[1];
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    const after = must(state, takeOne("ann", spot, bone.uid!), events, effects);
    expect(events).toEqual([{ t: "took", id: "ann", spot, items: [bone] }]);
    expect(effects).toEqual([{ type: "grant", heroId: "ann", xp: 0, resources: { bone: 2 } }]);
    // Bo is sent what Ann is: everything but the bone.
    for (const id of ["ann", "bo"]) expect(zoneView(after, id).loot![0].shared).toEqual(items.filter((item) => item !== bone));
    // He reaches for it a moment later: refused in plain words, and nothing is granted. She, clicking twice, is told as much.
    const late = stepZone(after, takeOne("bo", spot, bone.uid!));
    expect(late).toEqual({ ok: false, error: "Someone else took that." });
    expect(fails(after, takeOne("ann", spot, bone.uid!))).toBe("You have taken that already.");
    // What still lies there is his for the taking, and it is granted to him.
    const his: ZoneEffect[] = [];
    const then = must(after, takeOne("bo", spot, items[0].uid!), [], his);
    expect(his).toEqual([{ type: "grant", heroId: "bo", xp: 0, resources: {}, gold: 7 }]);
    expect(spotOf(then, spot).shared).toEqual(items.slice(2));
  });

  it("a thing is taken by its own number, never by where it lay: a click that lands after someone else's still takes what was clicked", () => {
    const { state, spot, items } = stocked();
    // Both have the window open on [gold, bone, iron, ...]. Bo takes the gold, and everything moves up a place.
    const after = must(state, takeOne("bo", spot, items[0].uid!));
    // Ann had clicked the bone, second in her list: it is the bone she gets, not the iron that lies second now.
    const effects: ZoneEffect[] = [];
    must(after, takeOne("ann", spot, items[1].uid!), [], effects);
    expect(effects).toEqual([{ type: "grant", heroId: "ann", xp: 0, resources: { bone: 2 } }]);
    // A place in the list names nothing in what is everyone's.
    expect(fails(after, take("ann", spot, 1))).toMatch(/not there any more/);
    expect(fails(state, take("ann", spot, 0))).toMatch(/not there any more/);
    // Nor does a number nothing there has.
    expect(fails(state, takeOne("ann", spot, 99))).toBe("Someone else took that.");
  });

  it("taking one thing takes that thing: it is granted, told, and gone from the list, the rest left as they lay", () => {
    const { state, spot, items } = stocked();
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    const after = must(state, takeOne("ann", spot, 2), events, effects);
    expect(events).toEqual([{ t: "took", id: "ann", spot, items: [items[1]] }]);
    expect(effects).toEqual([{ type: "grant", heroId: "ann", xp: 0, resources: { bone: 2 } }]);
    expect(spotOf(after, spot).shared).toEqual(items.filter((_, i) => i !== 1));
    // A piece of gear by itself.
    const geared: ZoneEffect[] = [];
    must(state, takeOne("ann", spot, 7), [], geared);
    expect(geared).toEqual([{ type: "grant", heroId: "ann", xp: 0, resources: {}, item: items[6].t === "gear" ? items[6].item : null }]);
  });

  it("taking all takes all that is there: the grants add up to exactly what lay there, a piece of gear or a lodestone to a grant", () => {
    const { state, spot, items, sword, helm } = stocked();
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    const after = must(state, take("ann", spot), events, effects);
    expect(events).toEqual([{ t: "took", id: "ann", spot, items }]);
    // Coin, materials and what there is to drink or throw in one grant, with the first of everything else; the second sword and stone in another.
    expect(effects).toEqual([
      { type: "grant", heroId: "ann", xp: 0, resources: { bone: 2, iron: 1 }, gold: 7, items: { healing: 1, fire: 2 }, item: sword, stone: ["hardy"], blueprint: "map_table", furnishing: { defId: "rug", label: "Rug" } },
      { type: "grant", heroId: "ann", xp: 0, resources: {}, item: helm, stone: [] },
    ]);
    expect(tallyGrants(effects)).toEqual(tallyItems(items));
    // What there is to drink or throw is in her pack on the map at once, on top of what she carried.
    expect(unit(after, "ann").items).toEqual({ healing: 1 + 1, fire: 2 });
    expect(unit(after, "bo").items).toEqual({ healing: 1 });
    expect(spotOf(after, spot).shared).toEqual([]);
    // The body is still there, emptied: for her, and for everybody.
    expect(fails(after, take("ann", spot))).toBe("There is nothing left in it.");
    expect(fails(after, take("bo", spot))).toBe("There is nothing left in it.");
    expect(unlooted(state, "ann")).toBe(1);
    expect(unlooted(state, "bo")).toBe(1);
    expect(unlooted(after, "ann")).toBe(0);
    expect(unlooted(after, "bo")).toBe(0);
  });

  it("both take all in turn: between them they are granted what lay there exactly once, each thing to whoever took it", () => {
    const { state, spot, items } = stocked();
    // Ann gets one thing out first; Bo sweeps up the rest; nothing is left for Ann's own sweep.
    const [hers, his]: [ZoneEffect[], ZoneEffect[]] = [[], []];
    let after = must(state, takeOne("ann", spot, items[5].uid!), [], hers);
    after = must(after, take("bo", spot), [], his);
    expect(fails(after, take("ann", spot))).toBe("There is nothing left in it.");
    expect(hers.every((e) => e.heroId === "ann")).toBe(true);
    expect(his.every((e) => e.heroId === "bo")).toBe(true);
    expect(tallyGrants(hers)).toEqual(tallyItems([items[5]]));
    expect(tallyGrants(his)).toEqual(tallyItems(items.filter((_, i) => i !== 5)));
    expect(tallyGrants([...hers, ...his])).toEqual(tallyItems(items));
    // And on bodies as the dice leave them: whoever sweeps first has all of it, and the other nothing.
    for (let seed = 1; seed <= 20; seed++) {
      const made = body(seed * 37);
      const looked = must(made.state, look("bo", made.spot));
      const found = spotOf(looked, made.spot).shared!;
      if (found.length === 0) {
        expect(fails(looked, take("bo", made.spot))).toBe("There is nothing left in it.");
        continue;
      }
      const paid: ZoneEffect[] = [];
      const swept = must(looked, take("bo", made.spot), [], paid);
      expect(paid.every((e) => e.heroId === "bo")).toBe(true);
      expect(tallyGrants(paid)).toEqual(tallyItems(found));
      expect(stepZone(swept, take("ann", made.spot))).toEqual({ ok: false, error: "There is nothing left in it." });
    }
  });

  it("taking without having looked first rolls it then, and takes it", () => {
    for (let seed = 1; seed <= 20; seed++) {
      const { state, spot } = body(seed);
      const rolled = spotOf(must(state, look("ann", spot)), spot).shared!;
      const step = stepZone(state, take("ann", spot));
      if (rolled.length === 0) {
        expect(step).toMatchObject({ ok: false, error: expect.stringMatching(/nothing left in it/) });
        continue;
      }
      if (!step.ok) throw new Error(step.error);
      expect(step.events).toEqual([{ t: "took", id: "ann", spot, items: rolled }]);
      expect(tallyGrants(step.effects)).toEqual(tallyItems(rolled));
    }
  });

  it("a body on a map saved when each hero had a share of their own, and already looked into then, is finished as it was begun", () => {
    const { state, spot } = body();
    // As such a map was saved: Ann's share rolled and half taken, Bo yet to look; nothing with a number on it.
    spotOf(state, spot).loot = { ann: [{ t: "gold", n: 4 }, { t: "res", kind: "iron", n: 1 }] };
    const effects: ZoneEffect[] = [];
    let after = must(state, take("ann", spot, 0), [], effects);
    expect(effects).toEqual([{ type: "grant", heroId: "ann", xp: 0, resources: {}, gold: 4 }]);
    // Bo's look rolls a share of his own, as it would have then; hers is as she left it, and nothing is everyone's.
    after = must(after, look("bo", spot));
    expect(spotOf(after, spot).shared).toBeUndefined();
    expect(spotOf(after, spot).loot.ann).toEqual([{ t: "res", kind: "iron", n: 1 }]);
    expect(Array.isArray(spotOf(after, spot).loot.bo)).toBe(true);
    expect(zoneView(after, "bo").loot![0].loot).toEqual({ bo: spotOf(after, spot).loot.bo });
    // One nobody had looked into by then is everyone's from here on.
    const fresh = body();
    expect(spotOf(must(fresh.state, look("bo", fresh.spot)), fresh.spot)).toMatchObject({ loot: {}, shared: expect.any(Array) });
  });

  it("is for a player's own hero, on their feet, beside it or standing over it, with no fight on", () => {
    const { state, spot } = body();
    // A stand-in, whoever plays it; and nobody plays someone else's hero.
    for (const action of [look("cy", spot, "ann"), take("cy", spot, undefined, "ann")]) expect(fails(state, action)).toMatch(/your own hero/);
    expect(fails(state, look("bo", spot, "ann"))).toMatch(/not yours/);
    // From afar.
    expect(hexDistance(unit(state, "di").pos, at(6, 6))).toBeGreaterThan(1);
    expect(fails(state, look("di", spot))).toMatch(/Go up to it/);
    expect(fails(state, take("di", spot))).toMatch(/Go up to it/);
    // Something that is not there.
    expect(fails(state, look("ann", "nothing"))).toMatch(/nothing there to search/);
    // A body takes up no room: she can stand right over it.
    const over = structuredClone(state);
    unit(over, "ann").pos = at(6, 6);
    expect(stepZone(over, look("ann", spot)).ok).toBe(true);
    // Not in the middle of a fight: another band turns up, and Ann is in it. Bo, who is not, searches on.
    const fighting = structuredClone(state);
    unit(fighting, "bo").pos = at(6, 6);
    unit(fighting, "ann").pos = at(15, 1);
    unit(fighting, "cy").pos = at(15, 2);
    enemy(fighting, "bandit", at(14, 1), "g2");
    let begun = startFight(fighting);
    expect(begun.encounter!.order).toContain("ann");
    expect(begun.encounter!.order).not.toContain("bo");
    // (Waiting for her turn, or on it: no. The fight is said before the distance is.)
    for (const turn of [0, 1]) {
      expect(fails(begun, look("ann", spot)), `turn ${turn}`).toMatch(begun.encounter!.acting[0] === "ann" ? /middle of a fight/ : /not your turn/);
      expect(fails(begun, take("ann", spot)), `turn ${turn}`).toMatch(begun.encounter!.acting[0] === "ann" ? /middle of a fight/ : /not your turn/);
      begun = must(begun, { type: "timeout" });
    }
    expect(stepZone(begun, look("bo", spot)).ok).toBe(true);
  });
});

// ---------- chests ----------

describe("a chest", () => {
  /** A strongbox at at(6, 6) guarded by the one band; Ann beside it, Bo a way off. */
  function strongbox() {
    const state = board();
    hero(state, "ann", at(5, 6));
    hero(state, "bo", at(2, 2));
    const guard = enemy(state, "bandit", at(9, 6));
    state.map.pois.push({ id: "box", kind: "cache", pos: at(6, 6), hidden: false, cleared: false, usedBy: [], enemies: [], loot: "vault", guard: "g1" });
    return { state, guard: guard.id };
  }
  const open = (id = "ann"): ZoneAction => ({ type: "open", by: id, unit: id, poi: "box" });

  it("is opened from beside it once its guards are down: its XP to the opener, and what is in it left there for whoever takes it first", () => {
    const made = strongbox();
    expect(fails(made.state, open())).toMatch(/guards still stand/);
    expect(fails(made.state, open("bo"))).toMatch(/Go up to it/);
    let state = win(startFight(made.state));
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = must(state, open(), events, effects);
    // Opened, paid its XP and nothing else, and looked into by whoever opened it.
    expect(events).toEqual([
      { t: "opened", id: "ann", poi: "box", loot: "vault" },
      { t: "spoils", id: "ann", xp: CHEST_PAY.vault.xp, resources: {} },
      { t: "looked", id: "ann", spot: "box" },
    ]);
    expect(effects).toEqual([{ type: "grant", heroId: "ann", xp: CHEST_PAY.vault.xp, resources: {} }]);
    expect(state.map.pois[0].cleared).toBe(true);
    const spot = spotOf(state, "box");
    expect(spot).toMatchObject({ kind: "chest", chest: "vault", name: "Strongbox", pos: at(6, 6), loot: {} });
    // A strongbox: gold in its span, a piece of gear and a potion for certain. One lot of it, for the two of them.
    const inside = spot.shared!;
    const held = tallyItems(inside);
    expect(held.gold).toBeGreaterThanOrEqual(CHEST_PAY.vault.gold[0]);
    expect(held.gold).toBeLessThanOrEqual(CHEST_PAY.vault.gold[1]);
    expect(held.gear).toHaveLength(1);
    expect(held.use.healing).toBe(1);
    expect(fails(state, open())).toMatch(/stands open already/);
    // Bo comes up and looks: he sees what she sees, and no dice are thrown for him.
    unit(state, "bo").pos = at(6, 5);
    state = must({ ...state, rng: 4242 }, look("bo", "box"));
    expect(spotOf(state, "box").shared).toEqual(inside);
    expect(zoneView(state, "bo").loot).toEqual(zoneView(state, "ann").loot);
    // He opened nothing and is paid nothing for it, but he is quicker to the gear: it is his, and gone for her.
    const gear = inside.find((item) => item.t === "gear")!;
    const his: ZoneEffect[] = [];
    state = must(state, takeOne("bo", "box", gear.uid!), [], his);
    expect(his).toEqual([{ type: "grant", heroId: "bo", xp: 0, resources: {}, item: gear.t === "gear" ? gear.item : null }]);
    for (const id of ["ann", "bo"]) expect(zoneView(state, id).loot!.find((s) => s.id === "box")!.shared).toEqual(inside.filter((item) => item !== gear));
    expect(stepZone(state, takeOne("ann", "box", gear.uid!))).toEqual({ ok: false, error: "Someone else took that." });
    // She takes all that is left: the rest and no more. Between them, what was in it exactly once.
    const hers: ZoneEffect[] = [];
    state = must(state, take("ann", "box"), [], hers);
    expect(hers.every((e) => e.heroId === "ann" && e.xp === 0)).toBe(true);
    expect(tallyGrants(hers).gear).toEqual([]);
    expect(tallyGrants([...his, ...hers])).toEqual(held);
    expect(spotOf(state, "box").shared).toEqual([]);
    expect(stepZone(state, take("bo", "box"))).toEqual({ ok: false, error: "There is nothing left in it." });
  });

  it("opened in a fight takes its AP and is not looked into until the fight is over", () => {
    const made = strongbox();
    made.state.map.pois[0].guard = undefined;
    let state = startFight(made.state);
    while (state.encounter!.acting[0] !== "ann") state = must(state, { type: "timeout" });
    const events: ZoneEvent[] = [];
    state = must(state, open(), events);
    expect(state.encounter!.budgets.ann.ap).toBe(AP_TURN - ITEM_AP.open);
    expect(events.map((e) => e.t)).toEqual(["opened", "spoils"]);
    expect(spotOf(state, "box")).toMatchObject({ loot: {} });
    expect(spotOf(state, "box").shared).toBeUndefined();
    expect(fails(state, look("ann", "box"))).toMatch(/middle of a fight/);
    state = win(state);
    expect(must(state, look("ann", "box")).loot!.find((s) => s.id === "box")!.shared!.length).toBeGreaterThan(0);
  });

  it("is called what it is: a chest, a strongbox, the hoard", () => {
    for (const [loot, name] of [["chest", "Chest"], ["vault", "Strongbox"], ["hoard", "The hoard"]] as const) {
      const state = board();
      hero(state, "ann", at(5, 6));
      state.map.pois.push({ id: "box", kind: "cache", pos: at(6, 6), hidden: false, cleared: false, usedBy: [], enemies: [], loot });
      expect(spotOf(must(state, open()), "box")).toMatchObject({ name, chest: loot });
    }
  });
});

// ---------- the spoils of a place ----------

describe("the spoils of a place the atlas made", () => {
  /** Ann, Bo and a stand-in of Ann's against one bandit on a map three rings out, opened by a stone that carried two things. */
  function cleared(rng = 99) {
    let state = board({ tier: 3, name: "Gull Rock", stone: 2 });
    hero(state, "ann", at(5, 6));
    hero(state, "bo", at(4, 7));
    hero(state, "cy", at(4, 5), "ann");
    const bandit = enemy(state, "bandit", at(7, 6));
    state = startFight(state);
    expect([...state.encounter!.order].sort()).toEqual(["ann", "bo", "cy", bandit.id].sort());
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = win(state, events, effects);
    state.rng = rng;
    return { state, events, effects, bandit: bandit.id };
  }

  it("are heaped beside whoever finished it the moment the last enemy falls: XP to each player's hero, and the rest to be taken", () => {
    const { state, events, effects, bandit } = cleared();
    const xp = bountyPay(3, 0).xp;
    // The fight's XP to each of the two, then the place's to each of the two; the stand-in is paid neither.
    expect(effects).toEqual([
      { type: "grant", heroId: "ann", xp: ENEMIES.bandit.xp, resources: {} },
      { type: "grant", heroId: "bo", xp: ENEMIES.bandit.xp, resources: {} },
      { type: "grant", heroId: "ann", xp, resources: {} },
      { type: "grant", heroId: "bo", xp, resources: {} },
    ]);
    const told = events.map((e) => e.t);
    expect(told.indexOf("cleared")).toBeGreaterThan(told.indexOf("fight_end"));
    expect(events[events.length - 1]).toEqual({ t: "bounty", spot: SPOILS_ID });
    expect(state.bounty).toBe(true);
    // Two things to search now: the bandit, and the heap, on a hex of its own beside a hero.
    expect(state.loot!.map((s) => [s.id, s.kind])).toEqual([[bandit, "body"], [SPOILS_ID, "spoils"]]);
    const heap = spotOf(state, SPOILS_ID);
    expect(heap).toMatchObject({ name: "The spoils of Gull Rock", loot: {} });
    expect(state.units.some((u) => posKey(u.pos) === posKey(heap.pos))).toBe(false);
    expect(posKey(heap.pos)).not.toBe(posKey(spotOf(state, bandit).pos));
    expect(Math.min(...["ann", "bo", "cy"].map((id) => hexDistance(unit(state, id).pos, heap.pos)))).toBe(1);
  });

  it("hold each hero's own share: what a good chest that far out would, and lodestones, never fewer than one", () => {
    const pay = bountyPay(3, 0);
    for (let seed = 1; seed <= 25; seed++) {
      let { state } = cleared(seed * 7);
      const heap = spotOf(state, SPOILS_ID);
      for (const id of ["ann", "bo"]) unit(state, id).pos = heap.pos;
      expect(fails(state, take("cy", SPOILS_ID, undefined, "ann"))).toMatch(/your own hero/);
      const shares: Record<string, Tally> = {};
      for (const id of ["ann", "bo"]) {
        const effects: ZoneEffect[] = [];
        state = must(state, take(id, SPOILS_ID), [], effects);
        expect(effects.every((e) => e.heroId === id && e.xp === 0)).toBe(true);
        const share = (shares[id] = tallyGrants(effects));
        expect(share.gold).toBeGreaterThanOrEqual(pay.gold[0]);
        expect(share.gold).toBeLessThanOrEqual(pay.gold[1]);
        // The stone that opened the place carried two things: the first stone back carries two or three, and there may be more.
        expect(share.stones.length, `seed ${seed} ${id}`).toBeGreaterThanOrEqual(1);
        const stones = effects.flatMap((e) => (e.stone ? [e.stone] : []));
        expect([2, 3]).toContain(stones[0].length);
        for (const stone of stones) expect(cleanStone(stone)).toEqual(stone);
      }
      expect(spotOf(state, SPOILS_ID).loot).toEqual({ ann: [], bo: [] });
    }
  });

  it("are each hero's own roll still: what one finds in the heap, or takes from it, is nothing to do with the other's", () => {
    let differ = 0;
    for (let seed = 1; seed <= 30; seed++) {
      let { state } = cleared(seed * 101);
      for (const id of ["ann", "bo"]) unit(state, id).pos = spotOf(state, SPOILS_ID).pos;
      state = must(must(state, look("ann", SPOILS_ID)), look("bo", SPOILS_ID));
      const before = structuredClone(spotOf(state, SPOILS_ID).loot);
      expect(Object.keys(before).sort()).toEqual(["ann", "bo"]);
      // Nothing in the heap is everyone's.
      expect(spotOf(state, SPOILS_ID).shared).toBeUndefined();
      if (JSON.stringify(before.ann) !== JSON.stringify(before.bo)) differ++;
      // Each is sent their own share and not a word of the other's.
      expect(zoneView(state, "ann").loot!.find((s) => s.id === SPOILS_ID)!.loot).toEqual({ ann: before.ann });
      expect(zoneView(state, "bo").loot!.find((s) => s.id === SPOILS_ID)!.loot).toEqual({ bo: before.bo });
      // Ann takes one thing of hers, then the rest: Bo's is as it was throughout, lodestones and all.
      const hers: ZoneEffect[] = [];
      state = must(state, takeOne("ann", SPOILS_ID, before.ann[0].uid!), [], hers);
      expect(spotOf(state, SPOILS_ID).loot).toEqual({ ann: before.ann.slice(1), bo: before.bo });
      state = must(state, take("ann", SPOILS_ID), [], hers);
      expect(spotOf(state, SPOILS_ID).loot).toEqual({ ann: [], bo: before.bo });
      expect(hers.every((e) => e.heroId === "ann")).toBe(true);
      expect(tallyGrants(hers)).toEqual(tallyItems(before.ann));
      // Emptied for her, and for her alone: a number that is still in his share takes nothing of his for her.
      expect(fails(state, take("ann", SPOILS_ID))).toMatch(/nothing left in it for you/);
      expect(fails(state, takeOne("ann", SPOILS_ID, before.bo[0].uid!))).toMatch(/not there any more/);
      expect(unlooted({ loot: [spotOf(state, SPOILS_ID)] }, "ann")).toBe(0);
      expect(unlooted({ loot: [spotOf(state, SPOILS_ID)] }, "bo")).toBe(1);
      const his: ZoneEffect[] = [];
      state = must(state, take("bo", SPOILS_ID), [], his);
      expect(his.every((e) => e.heroId === "bo")).toBe(true);
      expect(tallyGrants(his)).toEqual(tallyItems(before.bo));
      expect(tallyItems(before.bo).stones.length).toBeGreaterThanOrEqual(1);
    }
    expect(differ).toBeGreaterThan(20);
  });

  it("are not heaped twice, nor on a map the atlas did not make", () => {
    let { state } = cleared();
    enemy(state, "bandit", at(9, 6), "g2");
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = win(startFight(state), events, effects);
    expect(events.some((e) => e.t === "bounty")).toBe(false);
    expect(effects.map((e) => e.xp)).toEqual([ENEMIES.bandit.xp, ENEMIES.bandit.xp]);
    expect(state.loot!.filter((s) => s.kind === "spoils")).toHaveLength(1);
    // No tier: a won fight is a won fight.
    let plain = board();
    hero(plain, "ann", at(5, 6));
    enemy(plain, "bandit", at(7, 6));
    const [told, paid]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    plain = win(startFight(plain), told, paid);
    expect(told.some((e) => e.t === "cleared")).toBe(true);
    expect(told.some((e) => e.t === "bounty")).toBe(false);
    // The fight's XP and no more.
    expect(paid).toHaveLength(1);
    expect(plain.bounty).toBeUndefined();
    expect(plain.loot!.map((s) => s.kind)).toEqual(["body"]);
  });
});

describe("the bounty for clearing a map the atlas made", () => {
  /** Ann at level 1, a stand-in of hers, and a bandit they are fighting, on a map for a party of one. Winning it is one dev action. */
  function fight(options: Partial<ZoneState["options"]> = {}, level = 1): ZoneState {
    const state = board({ party: 1, ...options });
    state.rng = 4242;
    state.start = at(2, 6);
    hero(state, "ann", at(5, 6), undefined, 1);
    hero(state, "s1", at(4, 6), "ann", 1);
    enemy(state, "bandit", at(8, 6), "g1", level);
    return startFight(state);
  }

  /** The lodestones Ann takes out of the spoils of a place cleared, in the order they lay there. */
  const stonesTaken = (options: Partial<ZoneState["options"]>, rng: number) => {
    const start = fight(options);
    start.rng = rng;
    const effects: ZoneEffect[] = [];
    must(win(start, [], []), { type: "take", by: "ann", unit: "ann", spot: SPOILS_ID }, [], effects);
    return effects.flatMap((e) => (e.stone ? [e.stone] : []));
  };

  it("always holds a lodestone, each one fit to keep, and more of them the more the stone that opened the place carried; a chart-less map has no spoils at all", () => {
    const tries = 80;
    const mean: Record<number, number> = {};
    for (const carried of [0, 1, 3]) {
      let total = 0;
      for (let i = 0; i < tries; i++) {
        const stones = stonesTaken({ tier: 6, stone: carried }, i * 9973 + 11);
        // Never none. The first is as good as the stone that opened the place, or a thing better.
        expect(stones.length, `${carried} ${i}`).toBeGreaterThanOrEqual(1);
        expect([carried, Math.min(STONE_MODS, carried + 1)], `${carried} ${i}`).toContain(stones[0].length);
        for (const stone of stones) {
          expect(cleanStone(stone)).toEqual(stone);
          expect(stone.length).toBeLessThanOrEqual(STONE_MODS);
        }
        total += stones.length;
      }
      mean[carried] = total / tries;
    }
    expect(mean[1]).toBeGreaterThan(mean[0]);
    expect(mean[3]).toBeGreaterThan(mean[1]);
    // A place beside the Harbor is opened by no stone at all: it is reckoned as a plain one.
    for (let i = 0; i < 20; i++) expect(stonesTaken({ tier: 1 }, i + 1).length).toBeGreaterThanOrEqual(1);
    // A map the atlas did not make has no spoils to take, and what fell on it carried no stone.
    const plain = win(fight({}), [], []);
    expect(plain.loot!.map((s) => s.kind)).toEqual(["body"]);
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    unit(plain, "ann").pos = at(7, 6);
    must(plain, { type: "take", by: "ann", unit: "ann", spot: plain.loot![0].id }, events, effects);
    expect(effects.some((e) => e.stone)).toBe(false);
  });

  it("is more the further out, and more again for each modifier", () => {
    expect(bountyPay(6, 0).xp).toBeGreaterThan(bountyPay(3, 0).xp);
    expect(bountyPay(6, 0).gold[0]).toBeGreaterThan(bountyPay(3, 0).gold[1] - 12);
    expect(bountyPay(3, 0.4).xp).toBeGreaterThan(bountyPay(3, 0).xp);
    expect(bountyPay(3, 0.4).gear).toBeGreaterThan(bountyPay(3, 0).gear);
    expect(bountyPay(40, 2).gear).toBe(1);
    expect(bountyPay(40, 2).quality).toBe(0.9);

    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    win(fight({ tier: 3, mods: ["hardy", "numerous"] }), events, effects);
    expect(effects[1].xp).toBe(bountyPay(3, ZONE_MODS.hardy.pay + ZONE_MODS.numerous.pay).xp);
  });

  it("waits, in a delve, until the last chest is open; anywhere else a chest left shut holds nothing up", () => {
    const chest = { id: "chest1", kind: "cache" as const, pos: at(6, 6), hidden: false, cleared: false, usedBy: [], enemies: [], loot: "chest" as const };
    let state = fight({ tier: 2, delve: true });
    state.map.pois.push({ ...chest });
    const [events, effects]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = win(state, events, effects);
    expect(events.some((e) => e.t === "cleared")).toBe(true);
    expect(events.some((e) => e.t === "bounty")).toBe(false);
    expect(effects).toHaveLength(1);
    expect(state.bounty).toBeUndefined();

    const [opened, paid]: [ZoneEvent[], ZoneEffect[]] = [[], []];
    state = must(state, { type: "open", by: "ann", unit: "ann", poi: "chest1" }, opened, paid);
    // The chest's own XP, then the bounty's.
    expect(paid.map((e) => [e.heroId, e.xp])).toEqual([["ann", CHEST_PAY.chest.xp], ["ann", bountyPay(2, 0).xp]]);
    expect(opened).toContainEqual({ t: "bounty", spot: SPOILS_ID });
    expect(state.bounty).toBe(true);
    // The chest and the spoils are two heaps, each on a hex of its own.
    const spots = state.loot!.filter((s) => s.kind !== "body");
    expect(spots.map((s) => s.kind).sort()).toEqual(["chest", "spoils"]);
    expect(posKey(spots[0].pos)).not.toBe(posKey(spots[1].pos));

    // Under the sky the place is cleared when nobody is left to fight: its chest is the party's to open or to leave.
    let open = fight({ tier: 2 });
    open.map.pois.push({ ...chest });
    const told: ZoneEvent[] = [];
    open = win(open, told, []);
    expect(told).toContainEqual({ t: "bounty", spot: SPOILS_ID });
    expect(open.bounty).toBe(true);
  });

  it("makes a fight on such a map pay by the level of what fell", () => {
    const worth = (options: Partial<ZoneState["options"]>, level: number) => {
      const effects: ZoneEffect[] = [];
      win(fight(options, level), [], effects);
      return effects[0].xp;
    };
    expect(worth({}, 5)).toBe(ENEMIES.bandit.xp);
    expect(worth({ tier: 5 }, 1)).toBe(ENEMIES.bandit.xp);
    expect(worth({ tier: 5 }, 5)).toBe(Math.round(ENEMIES.bandit.xp * 1.6));
  });
});

// ---------- what a client is sent ----------

describe("what each player is sent of the loot", () => {
  it("is every spot: a body or a chest the same for everyone, and of the spoils only their own share", () => {
    let state = board({ tier: 2 });
    hero(state, "ann", at(5, 6));
    hero(state, "bo", at(6, 5));
    const bandit = enemy(state, "bandit", at(6, 6));
    state.map.pois.push({ id: "box", kind: "cache", pos: at(8, 8), hidden: false, cleared: false, usedBy: [], enemies: [], loot: "vault" });
    state = win(startFight(state));
    // Nobody has looked: every spot is there, with nothing in it yet for anyone.
    const fresh = zoneView(state, "ann");
    expect(fresh.loot!.map((s) => s.id)).toEqual([bandit.id, SPOILS_ID]);
    for (const s of fresh.loot!) expect(s).toMatchObject({ loot: {} });
    for (const s of fresh.loot!) expect(s.shared).toBeUndefined();
    // Ann looks into the heap and the body, and opens the strongbox; Bo into the heap and nothing else.
    for (const id of ["ann", "bo"]) unit(state, id).pos = spotOf(state, SPOILS_ID).pos;
    state = must(must(state, look("ann", SPOILS_ID)), look("bo", SPOILS_ID));
    for (const id of ["ann", "bo"]) unit(state, id).pos = at(6, 6);
    state = must(state, look("ann", bandit.id));
    unit(state, "ann").pos = at(8, 7);
    state = must(state, { type: "open", by: "ann", unit: "ann", poi: "box" });
    const [mine, his] = [zoneView(state, "ann"), zoneView(state, "bo")];
    const spotIn = (view: typeof mine, id: string) => view.loot!.find((s) => s.id === id)!;
    // The body and the strongbox: sent to both just as they stand, to Bo too, who has looked into neither.
    for (const id of [bandit.id, "box"]) {
      expect(spotIn(mine, id)).toEqual(spotOf(state, id));
      expect(spotIn(his, id)).toEqual(spotIn(mine, id));
      expect(spotIn(mine, id).loot).toEqual({});
    }
    expect(spotIn(mine, "box").shared!.length).toBeGreaterThan(0);
    // The spoils: each their own share and nobody else's.
    expect(spotIn(mine, SPOILS_ID).loot).toEqual({ ann: spotOf(state, SPOILS_ID).loot.ann });
    expect(spotIn(his, SPOILS_ID).loot).toEqual({ bo: spotOf(state, SPOILS_ID).loot.bo });
    expect(spotIn(mine, SPOILS_ID).shared).toBeUndefined();
    // Bo takes something out of the strongbox: both are sent it without that thing, and who has it.
    unit(state, "bo").pos = at(8, 7);
    const thing = spotOf(state, "box").shared![0];
    const after = must(state, takeOne("bo", "box", thing.uid!));
    for (const id of ["ann", "bo"]) {
      expect(spotIn(zoneView(after, id), "box").shared).toEqual(spotOf(state, "box").shared!.slice(1));
      expect(spotIn(zoneView(after, id), "box").gone).toEqual({ [thing.uid!]: "bo" });
    }
    // And the spoils are as they were for both of them.
    expect(spotIn(zoneView(after, "ann"), SPOILS_ID)).toEqual(spotIn(mine, SPOILS_ID));
    // Someone who has looked into nothing is told where everything is, what is everyone's, and no more.
    expect(zoneView(state, "zed").loot).toEqual(state.loot!.map((s) => ({ ...s, loot: {} })));
    expect(lootFor(state, "ann")).toEqual(mine.loot);
    // The dice are never sent, and the state itself is not changed by the telling.
    expect("rng" in mine || "seed" in mine).toBe(false);
    expect(Object.keys(spotOf(state, SPOILS_ID).loot).sort()).toEqual(["ann", "bo"]);
    // A map with nothing on it to search sends no list at all.
    expect(zoneView(board(), "ann").loot).toBeUndefined();
  });
});

// ---------- the tables ----------

describe("what a body holds", () => {
  const who = { classId: "qa_paladin", level: 4 };
  const KINDS = Object.keys(ENEMIES).filter((k) => k !== "dummy");
  const TRIES = 300;
  /** What one kind of enemy held over many bodies of it. */
  const bodies = (kind: string, options: { tier?: number } = {}, level = 3) => Array.from({ length: TRIES }, (_, i) => rollBody(makeRng(i * 7919 + 13), kind, level, who, options));

  it("follows from what it was: every enemy but the training dummy is of some family, and every family has its table", () => {
    for (const kind of KINDS) expect(ENEMY_FAMILY[kind], kind).toBeDefined();
    expect(ENEMY_FAMILY.dummy).toBeUndefined();
    for (const kind of Object.keys(ENEMY_FAMILY)) expect(ENEMIES[kind], kind).toBeDefined();
    for (const family of new Set(Object.values(ENEMY_FAMILY))) expect(FAMILY_LOOT[family].lines.length, family).toBeGreaterThan(0);
    // The newcomers of the atlas's maps among them.
    expect(ENEMY_FAMILY).toMatchObject({ spider: "bug", broodmother: "bug", frost_wolf: "beast", ember_hound: "beast", snow_bear: "beast", wraith: "dead", witch: "wild" });
    // What is nobody's kind holds nothing.
    expect(rollBody(makeRng(1), "dummy", 3, who, {})).toEqual([]);
    expect(rollBody(makeRng(1), "dragon", 3, who, {})).toEqual([]);
  });

  it("holds only what its family's table has, each thing listed once, and nothing in noughts", () => {
    for (const kind of KINDS) {
      const table = FAMILY_LOOT[ENEMY_FAMILY[kind]];
      const boss = !!ENEMIES[kind].boss;
      const res = new Set(table.lines.flatMap((l) => (l.res ? [l.res] : [])));
      const use = new Set(table.lines.flatMap((l) => (l.use ? [l.use] : [])));
      for (const items of bodies(kind, { tier: 4 })) {
        const names = items.map((i) => (i.t === "res" || i.t === "use" ? `${i.t}:${i.kind}` : i.t));
        expect(new Set(names).size, `${kind}: ${names.join(" ")}`).toBe(names.length);
        for (const i of items) {
          if (i.t === "res") expect(res.has(i.kind), `${kind} ${i.kind}`).toBe(true);
          else if (i.t === "use") expect(use.has(i.kind), `${kind} ${i.kind}`).toBe(true);
          else if (i.t === "gold") expect(boss || !!table.gold, `${kind} gold`).toBe(true);
          else if (i.t === "gear") expect(boss || (table.gear ?? 0) > 0, `${kind} gear`).toBe(true);
          else if (i.t === "stone") expect(boss, `${kind} stone`).toBe(true);
          else throw new Error(`${kind} holds a ${i.t}`);
          if ("n" in i) {
            expect(Number.isInteger(i.n), kind).toBe(true);
            expect(i.n, kind).toBeGreaterThanOrEqual(1);
          }
        }
      }
    }
  });

  it("a beast has hide and bone on it and nothing else; a bug, what an apothecary wants", () => {
    for (const kind of ["wolf", "bear", "bat", "frost_wolf", "ember_hound", "snow_bear"]) {
      const all = bodies(kind).flat();
      expect(new Set(all.map((i) => (i.t === "res" ? i.kind : i.t))), kind).toEqual(new Set(["fur", "bone"]));
    }
    const spider = bodies("spider");
    const found = new Set(spider.flat().map((i) => (i.t === "res" || i.t === "use" ? `${i.t}:${i.kind}` : i.t)));
    expect(found).toEqual(new Set(["res:mushrooms", "res:slime", "res:herbs", "use:poison", "use:acid"]));
    // Mostly mushrooms and slime; venom worth bottling only now and then.
    const share = (what: string) => spider.filter((items) => items.some((i) => (i.t === "res" || i.t === "use") && `${i.t}:${i.kind}` === what)).length / TRIES;
    expect(share("res:mushrooms")).toBeGreaterThan(0.45);
    expect(share("use:poison")).toBeLessThan(0.25);
    // A wolf nearly always has its pelt.
    expect(bodies("wolf").filter((items) => items.some((i) => i.t === "res" && i.kind === "fur")).length / TRIES).toBeGreaterThan(0.65);
  });

  it("raiders carry coin, more of it the higher their level; the dead and the wild only sometimes; oozes and constructs never", () => {
    const withGold = (kind: string) => bodies(kind).filter((items) => items.some((i) => i.t === "gold")).length / TRIES;
    expect(withGold("bandit")).toBeGreaterThan(0.8);
    expect(withGold("skeleton")).toBeGreaterThan(0.25);
    expect(withGold("skeleton")).toBeLessThan(0.55);
    expect(withGold("slime")).toBe(0);
    expect(withGold("wolf")).toBe(0);
    const purse = (level: number) => bodies("bandit", {}, level).flat().reduce((n, i) => n + (i.t === "gold" ? i.n : 0), 0);
    expect(purse(12)).toBeGreaterThan(purse(1));
    // A piece of gear worth keeping, once in a while, and it is the searcher's own class's.
    const gear = bodies("bandit").flat().flatMap((i) => (i.t === "gear" ? [i.item] : []));
    expect(gear.length).toBeGreaterThan(0);
    expect(gear.length / TRIES).toBeLessThan(0.15);
  });

  it("a boss always has gold on it, more of everything its kind has, gear more often than not, and on the atlas sometimes a lodestone", () => {
    const BOSSES = KINDS.filter((k) => ENEMIES[k].boss);
    expect(BOSSES).toEqual(expect.arrayContaining(["alpha", "great_bear", "broodmother", "villain", "haunt", "guardian"]));
    for (const kind of BOSSES) {
      const level = 5;
      const all = bodies(kind, { tier: 6 }, level);
      for (const items of all) {
        const gold = items.find((i) => i.t === "gold");
        // Even a beast, that would have none: the hoard of whatever it has eaten.
        expect(gold && gold.t === "gold" && gold.n, kind).toBeGreaterThanOrEqual(BOSS_LOOT.gold[0] + 2 * level);
        expect(gold && gold.t === "gold" && gold.n, kind).toBeLessThanOrEqual(BOSS_LOOT.gold[1] + 2 * level);
      }
      const share = (t: LootItem["t"], from = all) => from.filter((items) => items.some((i) => i.t === t)).length / TRIES;
      expect(share("gear"), kind).toBeGreaterThan(0.5);
      expect(Math.abs(share("stone") - BOSS_LOOT.stone), kind).toBeLessThan(0.1);
      // Off the atlas, never a stone.
      expect(share("stone", bodies(kind, {}, level)), kind).toBe(0);
      for (const stone of all.flat().flatMap((i) => (i.t === "stone" ? [i.stone] : []))) expect(cleanStone(stone)).toEqual(stone);
    }
    // A pack leader has twice the pelt a wolf would, when it has one.
    const most = (kind: string) => Math.max(...bodies(kind).flat().map((i) => (i.t === "res" && i.kind === "fur" ? i.n : 0)));
    expect(most("alpha")).toBe(2 * most("wolf"));
    // Nothing that is not a boss ever has a stone, atlas or no.
    for (const kind of KINDS.filter((k) => !ENEMIES[k].boss)) expect(bodies(kind, { tier: 9 }).flat().some((i) => i.t === "stone"), kind).toBe(false);
  });

  it("has a family for each sort of thing that lives on the maps: nine of them", () => {
    const families: Family[] = ["beast", "bug", "wild", "raider", "cult", "dead", "ooze", "giant", "construct"];
    expect(Object.keys(FAMILY_LOOT).sort()).toEqual([...families].sort());
    expect([...new Set(Object.values(ENEMY_FAMILY))].sort()).toEqual([...families].sort());
  });
});

describe("what a chest holds, and a place's spoils", () => {
  const who = { classId: "devops_mage", level: 3 };

  it("a chest: its gold first, within its span, a few materials, and gear and a potion as often as its kind says", () => {
    for (const kind of ["chest", "vault", "hoard"] as const) {
      const pay = CHEST_PAY[kind];
      const all = Array.from({ length: 300 }, (_, i) => rollChest(makeRng(i * 31 + 5), pay, who));
      for (const items of all) {
        expect(items[0].t).toBe("gold");
        expect(items[0].t === "gold" && items[0].n).toBeGreaterThanOrEqual(pay.gold[0]);
        expect(items[0].t === "gold" && items[0].n).toBeLessThanOrEqual(pay.gold[1]);
        expect(items.some((i) => i.t === "res")).toBe(true);
        expect(items.some((i) => i.t === "stone")).toBe(false);
      }
      const share = (t: LootItem["t"]) => all.filter((items) => items.some((i) => i.t === t)).length / all.length;
      expect(Math.abs(share("gear") - pay.gear), kind).toBeLessThan(0.1);
      expect(Math.abs(share("use") - pay.potion), kind).toBeLessThan(0.1);
    }
  });

  it("a place's spoils: a chest's worth at that ring, and its lodestones after, reckoned from the stone that opened it", () => {
    const count = (stone: number | undefined) => {
      let n = 0;
      for (let i = 0; i < 300; i++) {
        const items = rollSpoils(makeRng(i * 53 + 1), who, { tier: 5, stone });
        const pay = bountyPay(5, 0);
        expect(items[0].t === "gold" && items[0].n >= pay.gold[0]).toBe(true);
        const stones = items.filter((i) => i.t === "stone");
        expect(stones.length).toBeGreaterThanOrEqual(1);
        // The stones lie last in the heap.
        expect(items.slice(items.length - stones.length).every((i) => i.t === "stone")).toBe(true);
        n += stones.length;
      }
      return n / 300;
    };
    const [plain, fine] = [count(undefined), count(3)];
    expect(count(0)).toBe(plain);
    expect(fine).toBeGreaterThan(plain + 0.5);
  });
});

describe("the lodestones in a place's spoils", () => {
  const TRIES = 2000;
  const rolled = (carried: number | undefined, lode = 0, tier = 8) => Array.from({ length: TRIES }, (_, i) => spoilStones(makeRng(i * 104729 + 7), tier, carried, lode));

  it("are never none: the first is as good as the stone that opened the place, or one thing better a quarter of the time", () => {
    for (const carried of [0, 1, 2, 3]) {
      const all = rolled(carried);
      let better = 0;
      for (const stones of all) {
        expect(stones.length).toBeGreaterThanOrEqual(1);
        expect([carried, Math.min(STONE_MODS, carried + 1)]).toContain(stones[0].length);
        if (stones[0].length > carried) better++;
      }
      if (carried < STONE_MODS) expect(Math.abs(better / TRIES - SPOIL_STONES.better), `carried ${carried}`).toBeLessThan(0.04);
      else expect(better).toBe(0);
    }
    // A place opened by no stone at all is reckoned as a plain one's.
    expect(rolled(undefined)).toEqual(rolled(0));
  });

  it("are more the more that stone carried, and more again on a lode-bearing place; none carries more than three things", () => {
    const mean = (all: string[][][]) => all.reduce((n, stones) => n + stones.length, 0) / all.length;
    const means = [0, 1, 2, 3].map((carried) => mean(rolled(carried)));
    for (let q = 0; q < 3; q++) expect(means[q + 1], `carried ${q + 1}`).toBeGreaterThan(means[q] + 0.2);
    // A plain stone's place gives back one and now and then a second; one that carried three, three or more as often as not.
    expect(means[0]).toBeLessThan(1.5);
    expect(rolled(3).filter((stones) => stones.length >= 3).length / TRIES).toBeGreaterThan(0.4);
    expect(mean(rolled(1, 0.3))).toBeGreaterThan(mean(rolled(1)) + 0.3);
    // At most a chance for the place and one for each thing the stone carried, on top of the one that is always there.
    for (const carried of [0, 1, 2, 3]) {
      for (const stones of rolled(carried)) {
        expect(stones.length).toBeLessThanOrEqual(2 + carried);
        for (const stone of stones) {
          expect(stone.length).toBeLessThanOrEqual(STONE_MODS);
          expect(cleanStone(stone)).toEqual(stone);
          // The rest are a thing poorer than the stone was, its equal, or a thing better: never further off than that.
          expect(Math.abs(stone.length - carried)).toBeLessThanOrEqual(1);
        }
      }
    }
  });

  it("a stone asked for by size carries just that many things, whatever the ring: none is a plain one", () => {
    for (const tier of [1, 4, 12]) {
      for (let i = 0; i < 200; i++) {
        for (const size of [0, 1, 2, 3]) expect(rollStone(makeRng(i * 17 + size), tier, size), `ring ${tier}`).toHaveLength(size);
        // Left to itself it carries what that ring can show: one thing near the Harbor, up to three far out.
        const free = rollStone(makeRng(i * 17 + 5), tier);
        expect(free.length).toBeGreaterThanOrEqual(1);
        expect(free.length).toBeLessThanOrEqual(tier <= 3 ? 1 : tier <= 7 ? 2 : STONE_MODS);
      }
    }
    expect(rollStone(makeRng(1), 5, 9)).toHaveLength(STONE_MODS);
    expect(rollStone(makeRng(1), 5, -1)).toEqual([]);
  });
});
