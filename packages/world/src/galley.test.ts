// The galley: dishes and their caps, the check a cook must pass, and what a
// crew's larder does to a voyage as it opens and at the landing.

import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  CANNED_FILLS,
  DISHES,
  GALLEY_PROJECT,
  LANDING_REST_HP,
  STORY_FRAMES,
  buildBible,
  cleanLarder,
  cookProblem,
  createWorld,
  eatsChowder,
  galleyBoon,
  larderText,
  poiById,
  projectById,
  stepWorld,
  type HeroInit,
  type WorldAction,
  type WorldEvent,
  type WorldState,
} from "./index";

describe("the galley project", () => {
  it("is open, with its catalogue cost", () => {
    expect(projectById(GALLEY_PROJECT)).toMatchObject({ open: true, cost: { gold: 250, wood: 30, fur: 15, bone: 10 } });
  });
});

describe("cooking", () => {
  const plenty = { bone: 10, herbs: 10, fur: 10, mushrooms: 10 };

  it("has two dishes with the agreed recipes and caps", () => {
    expect(DISHES.map((d) => [d.id, d.recipe, d.cap])).toEqual([
      ["chowder", { bone: 2, herbs: 2 }, 4],
      ["stores", { fur: 2, mushrooms: 3 }, 2],
    ]);
  });

  it("needs the galley built, the materials, and room in the larder", () => {
    const empty = { chowder: 0, stores: 0 };
    expect(cookProblem("chowder", { built: true, larder: empty, resources: plenty })).toBeNull();
    expect(cookProblem("chowder", { built: false, larder: empty, resources: plenty })).toMatch(/not built/);
    expect(cookProblem("chowder", { built: true, larder: { chowder: 4, stores: 0 }, resources: plenty })).toMatch(/already holds 4/);
    expect(cookProblem("chowder", { built: true, larder: { chowder: 3, stores: 2 }, resources: plenty })).toBeNull();
    expect(cookProblem("stores", { built: true, larder: { chowder: 0, stores: 2 }, resources: plenty })).toMatch(/already holds 2/);
    expect(cookProblem("stores", { built: true, larder: empty, resources: { fur: 2, mushrooms: 2 } })).toMatch(/3 mushrooms/);
    expect(cookProblem("feast", { built: true, larder: empty, resources: plenty })).toBe("No such dish.");
  });

  it("holds a larder to whole numbers within each dish's cap", () => {
    expect(cleanLarder({ chowder: 9, stores: -1, cake: 3 })).toEqual({ chowder: 4, stores: 0 });
    expect(cleanLarder({ chowder: 2.7, stores: "2" })).toEqual({ chowder: 2, stores: 0 });
    expect(cleanLarder(null)).toEqual({ chowder: 0, stores: 0 });
    expect(larderText({ chowder: 3, stores: 2 })).toBe("3 chowders and 2 days of stores");
    expect(larderText({ chowder: 1 })).toBe("1 chowder");
    expect(larderText({})).toBe("");
  });

  it("turns a larder into doom days, chowder in the hold and a line", () => {
    expect(galleyBoon({ chowder: 3, stores: 2 })).toEqual({ doomDays: 2, chowder: 3, line: "The galley stocked the hold: 3 chowders and 2 days of stores." });
    expect(galleyBoon({ stores: 99 }).doomDays).toBe(2);
    expect(galleyBoon(undefined)).toEqual({ doomDays: 0, chowder: 0, line: null });
  });

  it("only eats a chowder when the plain rest would leave the hero short", () => {
    const full = { hp: 30, maxHp: 30, focus: 3, maxFocus: 3 };
    expect(eatsChowder(full, 2)).toBe(false);
    expect(eatsChowder({ ...full, hp: 30 - LANDING_REST_HP }, 2)).toBe(false);
    expect(eatsChowder({ ...full, hp: 30 - LANDING_REST_HP - 1 }, 2)).toBe(true);
    expect(eatsChowder({ ...full, focus: 2 }, 2)).toBe(true);
    expect(eatsChowder({ ...full, hp: 1 }, 0)).toBe(false);
  });
});

describe("a larder on the voyage", () => {
  const frame = STORY_FRAMES[0];
  const fill = CANNED_FILLS.stolen_relic[0];
  const hero: HeroInit = { id: "p1", name: "P1", classId: "qa_paladin", level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS.qa_paladin }, bonus: {}, weapon: "mace", weaponPower: 0, armor: 0 };

  function begin(seed: string, larder?: unknown): { state: WorldState; events: WorldEvent[] } {
    let state = createWorld("CODE", seed, ["galley"]);
    const events: WorldEvent[] = [];
    const actions: WorldAction[] = [{ type: "join", hero }, { type: "start", heroId: "p1" }, { type: "begin", bible: buildBible(frame, fill), larder }];
    for (const action of actions) {
      const res = stepWorld(state, action);
      if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
      state = res.state;
      events.push(...res.events);
    }
    return { state, events };
  }

  it("adds a day per store to the clock, puts chowder in the hold, and says so", () => {
    const plain = begin("larder-1");
    const stocked = begin("larder-1", { chowder: 3, stores: 2 });
    expect(stocked.state.doom).toBe(plain.state.doom + 2);
    expect(stocked.state.larder).toEqual({ chowder: 3 });
    expect(plain.state.larder).toBeUndefined();
    expect(stocked.events).toContainEqual({ t: "harbor_boon", projectId: "galley", text: "The galley stocked the hold: 3 chowders and 2 days of stores." });
    expect(plain.events.some((e) => e.t === "harbor_boon" && e.projectId === "galley")).toBe(false);
  });

  it("never gives more than the caps, whatever the server sends", () => {
    const plain = begin("larder-2");
    const greedy = begin("larder-2", { chowder: 50, stores: 50 });
    expect(greedy.state.doom).toBe(plain.state.doom + 2);
    expect(greedy.state.larder).toEqual({ chowder: 4 });
  });

  it("feeds a hurt hero at the landing back to full, one bowl at a time, then falls back to the plain rest", () => {
    let { state } = begin("larder-3", { chowder: 1 });
    const landing = poiById(state.map, "landing")!.pos;
    const rest = (s: WorldState) => {
      const h = s.heroes[0];
      h.pos = { ...landing };
      h.hp = 3;
      h.focus = 0;
      s.turn = { ...s.turn!, heroId: h.id, acted: false };
      const res = stepWorld(s, { type: "interact", heroId: h.id });
      if (!res.ok) throw new Error(res.error);
      return res;
    };
    const first = rest(state);
    const h = first.state.heroes[0];
    expect(h.hp).toBe(h.maxHp);
    expect(h.focus).toBe(h.maxFocus);
    expect(first.state.larder).toEqual({ chowder: 0 });
    expect(first.events).toContainEqual({ t: "rest", heroId: "p1", hp: h.maxHp - 3, focus: h.maxFocus, where: "landing", ate: "chowder", left: 0 });
    state = first.state;
    const second = rest(state);
    expect(second.state.heroes[0].hp).toBe(3 + LANDING_REST_HP);
    expect(second.events).toContainEqual({ t: "rest", heroId: "p1", hp: LANDING_REST_HP, focus: 0, where: "landing" });
  });
});
