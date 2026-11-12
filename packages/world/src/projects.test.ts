// Harbor projects: the contribution check, completion, and the lighthouse's
// extra day on a voyage's doom clock.

import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  CANNED_FILLS,
  coastHexes,
  projectLock,
  projectProgress,
  projectLockText,
  type ProjectProgress,
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
/** A crew with both workshops up, so the second tier is unlocked. */
const workshopsUp: ProjectProgress[] = [
  { id: "apothecary", paid: {}, builtAt: 1 },
  { id: "smithy", paid: {}, builtAt: 2 },
];
const check = (id: string, state: { paid: Record<string, number>; built: boolean }, holdings: Record<string, number>, give: unknown, crew: ProjectProgress[] = workshopsUp) =>
  checkContribution(id, state, holdings, give, crew);

describe("project catalogue", () => {
  it("lists four projects, workshops first", () => {
    expect(PROJECTS.map((p) => p.id)).toEqual(["apothecary", "smithy", "lighthouse", "galley"]);
    expect(PROJECTS.filter((p) => p.open).map((p) => p.id)).toEqual(["apothecary", "smithy", "lighthouse", "galley"]);
    for (const p of PROJECTS) {
      expect(Object.values(p.cost).every((n) => Number.isInteger(n) && n! > 0), p.id).toBe(true);
      expect(p.benefit.length).toBeGreaterThan(0);
    }
  });

  it("measures progress with each cost counting the same", () => {
    expect(projectProgress(lighthouse, {})).toBe(0);
    expect(projectProgress(lighthouse, { gold: 300 })).toBe(0.25);
    expect(projectProgress(lighthouse, { gold: 9999, wood: 15 })).toBe(0.375);
    expect(projectProgress(lighthouse, lighthouse.cost)).toBe(1);
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

describe("unlocking the second tier", () => {
  const none: ProjectProgress[] = [];
  const at = (id: string, builtAt: number | null, paid: Record<string, number> = {}): ProjectProgress => ({ id, paid, builtAt });

  it("opens the apothecary and the smithy from the start, and locks the lighthouse and the galley", () => {
    expect(projectLock("apothecary", none)).toBeNull();
    expect(projectLock("smithy", none)).toBeNull();
    expect(projectLock("lighthouse", none)).toEqual({ needs: ["apothecary", "smithy"] });
    expect(projectLock("galley", none)).toEqual({ needs: ["apothecary", "smithy"] });
    expect(projectLockText({ needs: ["apothecary", "smithy"] })).toBe("Unlocks once the Apothecary and the Smithy are built.");
    expect(check("apothecary", fresh, rich, { gold: 10 }, none).ok).toBe(true);
    expect(check("lighthouse", fresh, rich, { gold: 10 }, none)).toEqual({ ok: false, error: "The Lighthouse is locked. Unlocks once the Apothecary and the Smithy are built." });
    expect(check("galley", fresh, rich, { gold: 10 }, none).ok).toBe(false);
  });

  it("needs both workshops built: one, or one only paid for, is not enough", () => {
    const smithyOnly = [at("apothecary", null, { gold: 250 }), at("smithy", 9)];
    expect(projectLock("lighthouse", smithyOnly)).toEqual({ needs: ["apothecary"] });
    expect(projectLockText({ needs: ["apothecary"] })).toBe("Unlocks once the Apothecary is built.");
    expect(check("lighthouse", fresh, rich, { gold: 10 }, smithyOnly).ok).toBe(false);
    expect(projectLock("lighthouse", workshopsUp)).toBeNull();
    expect(projectLock("galley", workshopsUp)).toBeNull();
    expect(check("lighthouse", fresh, rich, { gold: 10 }, workshopsUp).ok).toBe(true);
  });

  it("never takes away a lighthouse or galley a crew already built or began", () => {
    const begun = [at("lighthouse", null, { gold: 120, wood: 4 })];
    expect(projectLock("lighthouse", begun)).toBeNull();
    expect(check("lighthouse", { paid: { gold: 120, wood: 4 }, built: false }, rich, { gold: 10 }, begun).ok).toBe(true);
    // Only the project that was begun: the galley next to it is still locked.
    expect(projectLock("galley", begun)).toEqual({ needs: ["apothecary", "smithy"] });
    expect(projectLock("galley", [at("galley", 7)])).toBeNull();
    // A row with nothing actually paid in (zeros) is not a start.
    expect(projectLock("lighthouse", [at("lighthouse", null, { gold: 0 })])).toEqual({ needs: ["apothecary", "smithy"] });
  });
});

describe("contributions", () => {
  it("accepts a gift the player holds and the project needs", () => {
    const res = check("lighthouse", { paid: { gold: 100 }, built: false }, { gold: 60, wood: 5 }, { gold: 50, wood: 5, stone: 0 });
    expect(res).toEqual({ ok: true, give: { gold: 50, wood: 5 }, paid: { gold: 150, wood: 5 }, completes: false });
  });

  it("cannot over-pay a cost", () => {
    const res = check("lighthouse", { paid: { iron: 8 }, built: false }, rich, { iron: 3 });
    expect(res).toEqual({ ok: false, error: "The Lighthouse only needs 2 more iron." });
    expect(check("lighthouse", { paid: { iron: 10 }, built: false }, rich, { iron: 1 }).ok).toBe(false);
    // Exactly what is left is fine.
    expect(check("lighthouse", { paid: { iron: 8 }, built: false }, rich, { iron: 2 }).ok).toBe(true);
  });

  it("cannot give what the player does not hold", () => {
    expect(check("lighthouse", fresh, { gold: 10 }, { gold: 11 })).toEqual({ ok: false, error: "You do not have 11 gold." });
    expect(check("lighthouse", fresh, {}, { wood: 1 }).ok).toBe(false);
    // One bad line refuses the whole gift.
    expect(check("lighthouse", fresh, { gold: 100 }, { gold: 100, stone: 1 }).ok).toBe(false);
  });

  it("refuses nonsense amounts and things the project does not use", () => {
    for (const give of [null, 5, "gold", [], {}, { gold: 0 }, { gold: -5 }, { gold: 1.5 }, { gold: "20" }, { gold: Number.NaN }, { gold: Infinity }, { fur: 1 }, { rubies: 1 }]) {
      expect(check("lighthouse", fresh, rich, give).ok, JSON.stringify(give)).toBe(false);
    }
  });

  it("refuses unknown projects, and takes gifts for the galley now it is open", () => {
    expect(check("castle", fresh, rich, { gold: 1 })).toEqual({ ok: false, error: "No such project." });
    expect(check("galley", fresh, rich, { gold: 1, fur: 15 })).toMatchObject({ ok: true, give: { gold: 1, fur: 15 }, completes: false });
  });

  it("completes when the last cost is met, and takes nothing after that", () => {
    let paid = {};
    const first = check("lighthouse", { paid, built: false }, rich, { gold: 300, wood: 30, stone: 30 });
    if (!first.ok) throw new Error(first.error);
    expect(first.completes).toBe(false);
    paid = first.paid;
    const last = check("lighthouse", { paid, built: false }, rich, { iron: 10 });
    if (!last.ok) throw new Error(last.error);
    expect(last.completes).toBe(true);
    expect(last.paid).toEqual(lighthouse.cost);
    expect(check("lighthouse", { paid: last.paid, built: true }, rich, { gold: 1 })).toEqual({ ok: false, error: "The Lighthouse is already built." });
    // Built is permanent even if the stored amounts were somehow short.
    expect(check("lighthouse", { paid: {}, built: true }, rich, { gold: 1 }).ok).toBe(false);
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

  it("only the lighthouse changes the voyage itself, and only once", () => {
    expect(voyageBoons(undefined)).toEqual({ doomDays: 0, chartCoast: false, lines: [] });
    expect(voyageBoons(["apothecary", "smithy", "galley", "castle"])).toEqual({ doomDays: 0, chartCoast: false, lines: [] });
    expect(voyageBoons(["lighthouse", "lighthouse"])).toMatchObject({ doomDays: 1, chartCoast: true });
    expect(voyageBoons(["lighthouse", "lighthouse"]).lines).toHaveLength(1);
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
      expect((boons[0] as { text: string }).text).toMatch(/whole coast/);
      expect(plain.events.some((e) => e.t === "harbor_boon")).toBe(false);
      // Nothing else about the voyage changes: same island, same rolls.
      expect(lit.state.map).toEqual(plain.state.map);
      expect(lit.state.rng).toBe(plain.state.rng);
    }
  });

  it("the lighthouse's chart opens the voyage with the whole coast seen, and touches nothing else", () => {
    for (const seed of ["lamp-1", "lamp-2", "lamp-3", "lamp-4"]) {
      const plain = begin(createWorld("PLAIN", seed));
      const lit = begin(createWorld("LIT", seed, ["lighthouse"]));
      const coast = coastHexes(lit.state.map);
      const tile = (key: string) => lit.state.map.tiles.find((t) => `${t.q},${t.r}` === key)!;
      // Every land hex on the coast touches the sea, and there is real coast to chart.
      const shore = coast.filter((k) => tile(k).biome !== "water");
      expect(shore.length, seed).toBeGreaterThan(10);
      const litSeen = new Set(lit.state.seen);
      const plainSeen = new Set(plain.state.seen);
      for (const k of coast) expect(litSeen.has(k), `${seed} ${k}`).toBe(true);
      // Without it, most of the coast is still fog; with it, nothing else beyond the landing's sight is lifted.
      expect(shore.filter((k) => !plainSeen.has(k)).length, seed).toBeGreaterThan(5);
      expect([...litSeen].every((k) => plainSeen.has(k) || coast.includes(k)), seed).toBe(true);
      expect(new Set(lit.state.seen).size).toBe(lit.state.seen!.length);
      // Same island, same rolls, and the same bands in the same places.
      expect(lit.state.map).toEqual(plain.state.map);
      expect(lit.state.rng).toBe(plain.state.rng);
      expect(lit.state.roamers).toEqual(plain.state.roamers);
    }
  });

  it("a voyage saved before projects existed still begins", () => {
    const old = createWorld("OLD", "lamp-1");
    delete old.projects;
    expect(begin(old).state.doom).toBe(begin(createWorld("NEW", "lamp-1")).state.doom);
  });
});
