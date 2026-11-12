// Harbor projects: the contribution check, completion, and the lighthouse's
// extra day on a voyage's doom clock.

import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  CANNED_FILLS,
  PROJECTS,
  STORY_FRAMES,
  buildBible,
  builtProjects,
  checkContribution,
  createWorld,
  projectAmountsText,
  projectById,
  projectComplete,
  projectGivable,
  projectRemaining,
  stepWorld,
  voyageBoons,
  type HeroInit,
  type WorldAction,
  type WorldEvent,
  type WorldState,
} from "./index";

const lighthouse = projectById("lighthouse")!;
const rich = { gold: 1000, wood: 100, stone: 100, iron: 100, copper: 100, fur: 100, bone: 100 };
const fresh = { paid: {}, built: false };

describe("project catalogue", () => {
  it("lists three projects, of which only the lighthouse is open", () => {
    expect(PROJECTS.map((p) => p.id)).toEqual(["lighthouse", "smithy", "galley"]);
    expect(PROJECTS.filter((p) => p.open).map((p) => p.id)).toEqual(["lighthouse"]);
    for (const p of PROJECTS) {
      expect(Object.values(p.cost).every((n) => Number.isInteger(n) && n! > 0), p.id).toBe(true);
      expect(p.benefit.length).toBeGreaterThan(0);
    }
  });

  it("works out what is left and what a player could give", () => {
    const paid = { gold: 250, wood: 30 };
    expect(projectRemaining(lighthouse, paid)).toEqual({ gold: 50, stone: 30, iron: 10 });
    expect(projectGivable(lighthouse, paid, { gold: 500, wood: 9, stone: 4 })).toEqual({ gold: 50, stone: 4 });
    expect(projectComplete(lighthouse, paid)).toBe(false);
    expect(projectComplete(lighthouse, lighthouse.cost)).toBe(true);
    expect(projectAmountsText({ wood: 5, gold: 20 })).toBe("20 gold, 5 wood");
  });
});

describe("contributions", () => {
  it("accepts a gift the player holds and the project needs", () => {
    const res = checkContribution("lighthouse", { paid: { gold: 100 }, built: false }, { gold: 60, wood: 5 }, { gold: 50, wood: 5, stone: 0 });
    expect(res).toEqual({ ok: true, give: { gold: 50, wood: 5 }, paid: { gold: 150, wood: 5 }, completes: false });
  });

  it("cannot over-pay a cost", () => {
    const res = checkContribution("lighthouse", { paid: { iron: 8 }, built: false }, rich, { iron: 3 });
    expect(res).toEqual({ ok: false, error: "The Lighthouse only needs 2 more iron." });
    expect(checkContribution("lighthouse", { paid: { iron: 10 }, built: false }, rich, { iron: 1 }).ok).toBe(false);
    // Exactly what is left is fine.
    expect(checkContribution("lighthouse", { paid: { iron: 8 }, built: false }, rich, { iron: 2 }).ok).toBe(true);
  });

  it("cannot give what the player does not hold", () => {
    expect(checkContribution("lighthouse", fresh, { gold: 10 }, { gold: 11 })).toEqual({ ok: false, error: "You do not have 11 gold." });
    expect(checkContribution("lighthouse", fresh, {}, { wood: 1 }).ok).toBe(false);
    // One bad line refuses the whole gift.
    expect(checkContribution("lighthouse", fresh, { gold: 100 }, { gold: 100, stone: 1 }).ok).toBe(false);
  });

  it("refuses nonsense amounts and things the project does not use", () => {
    for (const give of [null, 5, "gold", [], {}, { gold: 0 }, { gold: -5 }, { gold: 1.5 }, { gold: "20" }, { gold: Number.NaN }, { gold: Infinity }, { fur: 1 }, { rubies: 1 }]) {
      expect(checkContribution("lighthouse", fresh, rich, give).ok, JSON.stringify(give)).toBe(false);
    }
  });

  it("refuses unknown projects and ones that are not yet open", () => {
    expect(checkContribution("castle", fresh, rich, { gold: 1 })).toEqual({ ok: false, error: "No such project." });
    expect(checkContribution("smithy", fresh, rich, { gold: 1 })).toEqual({ ok: false, error: "The Smithy is not yet open." });
    expect(checkContribution("galley", fresh, rich, { gold: 1 }).ok).toBe(false);
  });

  it("completes when the last cost is met, and takes nothing after that", () => {
    let paid = {};
    const first = checkContribution("lighthouse", { paid, built: false }, rich, { gold: 300, wood: 30, stone: 30 });
    if (!first.ok) throw new Error(first.error);
    expect(first.completes).toBe(false);
    paid = first.paid;
    const last = checkContribution("lighthouse", { paid, built: false }, rich, { iron: 10 });
    if (!last.ok) throw new Error(last.error);
    expect(last.completes).toBe(true);
    expect(last.paid).toEqual(lighthouse.cost);
    expect(checkContribution("lighthouse", { paid: last.paid, built: true }, rich, { gold: 1 })).toEqual({ ok: false, error: "The Lighthouse is already built." });
    // Built is permanent even if the stored amounts were somehow short.
    expect(checkContribution("lighthouse", { paid: {}, built: true }, rich, { gold: 1 }).ok).toBe(false);
  });
});

describe("what built projects give a voyage", () => {
  const frame = STORY_FRAMES[0];
  const fill = CANNED_FILLS.stolen_relic[0];
  const hero: HeroInit = { id: "p1", name: "P1", classId: "qa_paladin", level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS.qa_paladin }, bonus: {}, weapon: "mace", weaponPower: 0, armor: 0 };

  function begin(state: WorldState): { state: WorldState; events: WorldEvent[] } {
    const events: WorldEvent[] = [];
    const actions: WorldAction[] = [{ type: "join", hero }, { type: "start", heroId: "p1" }, { type: "begin", bible: buildBible(frame, fill) }];
    for (const action of actions) {
      const res = stepWorld(state, action);
      if (!res.ok) throw new Error(`${action.type} failed: ${res.error}`);
      state = res.state;
      events.push(...res.events);
    }
    return { state, events };
  }

  it("only the lighthouse does anything, and only once", () => {
    expect(voyageBoons(undefined)).toEqual({ doomDays: 0, lines: [] });
    expect(voyageBoons(["smithy", "galley", "castle"])).toEqual({ doomDays: 0, lines: [] });
    expect(voyageBoons(["lighthouse", "lighthouse"]).doomDays).toBe(1);
    expect(builtProjects({ projects: [{ id: "lighthouse", paid: {}, builtAt: 5 }, { id: "smithy", paid: {}, builtAt: null }], gifts: [] })).toEqual(["lighthouse"]);
    expect(builtProjects(undefined)).toEqual([]);
  });

  it("the lighthouse adds one day to the doom clock and says so as the voyage opens", () => {
    for (const seed of ["lamp-1", "lamp-2", "lamp-3"]) {
      const plain = begin(createWorld("PLAIN", seed));
      const lit = begin(createWorld("LIT", seed, ["lighthouse"]));
      expect(lit.state.doom, seed).toBe(plain.state.doom + 1);
      expect(lit.state.projects).toEqual(["lighthouse"]);
      const boons = lit.events.filter((e) => e.t === "harbor_boon");
      expect(boons).toHaveLength(1);
      expect(boons[0]).toMatchObject({ projectId: "lighthouse" });
      expect((boons[0] as { text: string }).text).toMatch(/one more day/);
      expect(plain.events.some((e) => e.t === "harbor_boon")).toBe(false);
      // Nothing else about the voyage changes: same island, same rolls.
      expect(lit.state.map).toEqual(plain.state.map);
      expect(lit.state.rng).toBe(plain.state.rng);
    }
  });

  it("a voyage saved before projects existed still begins", () => {
    const old = createWorld("OLD", "lamp-1");
    delete old.projects;
    expect(begin(old).state.doom).toBe(begin(createWorld("NEW", "lamp-1")).state.doom);
  });
});
