// What a zone's client shows before the server has answered (client/zone/ahead.ts), held against the real
// reducer: a walk shown ahead is always the start of the walk the server then makes, a walk the server would
// refuse is never shown, and an answer that differs from what was shown is settled by cutting the picture back.

import { describe, expect, it } from "vitest";
import { hexDistance, type HexPos } from "@gantt-quest/core";
import { createZone, makeRng, standInHero, stepZone, zoneOptions, zoneView, type ZoneEvent, type ZoneState, type ZoneView } from "@gantt-quest/world";
import { believe, foreseeWalk, giveUp, settle, standing, type Ahead, type WalkAhead } from "../src/client/zone/ahead";

/** A generated meadow with wolves on it, Ann walked in, and the enemy told to hold still on its turns so hers come round. */
function meadow(seed: string, options: Record<string, unknown> = {}): ZoneState {
  let state = createZone("TEST", seed, zoneOptions({ size: "small", biome: "meadow", groups: 2, kinds: ["wolf"], elevation: 1, obstacles: 2, clear: 3, party: 1, ...options }));
  for (const action of [{ type: "join", hero: standInHero("qa_paladin", "ann", 1)! }, { type: "dev", by: "ann", dev: { op: "ai", off: true } }] as const) {
    const step = stepZone(state, action);
    if (!step.ok) throw new Error(step.error);
    state = step.state;
  }
  return state;
}

const ann = (state: ZoneState | ZoneView) => state.units.find((u) => u.id === "ann")!;
/** Every hex the server walked Ann through in these events, in order. */
const walkedBy = (events: ZoneEvent[]) => events.flatMap((ev) => (ev.t === "moved" && ev.id === "ann" ? ev.path : []));
const walkAhead = (n: number, from: HexPos, path: HexPos[], extra: Partial<WalkAhead> = {}): WalkAhead => ({ n, kind: "walk", unit: "ann", from, path, cost: path.length, at: 0, ...extra });
const hex = (q: number, r: number): HexPos => ({ q, r });

describe("a walk shown ahead of the server", () => {
  it("is always the start of the walk the server makes, and is never shown for a walk the server refuses", () => {
    let shown = 0;
    let refused = 0;
    let fights = 0;
    for (const seed of ["a", "b", "c", "d", "e", "f"]) {
      let state = meadow(seed);
      const rng = makeRng(seed.charCodeAt(0) * 7919);
      for (let i = 0; i < 60; i++) {
        const me = ann(state);
        // Anywhere within a few hexes: open ground, trees, rock, a wolf's own hex, out of reach on a turn.
        const near = state.map.tiles.filter((t) => hexDistance(t, me.pos) <= 5);
        const to = near[rng.int(0, near.length - 1)];
        const seen = foreseeWalk(zoneView(state, "ann"), "ann", { q: to.q, r: to.r });
        const step = stepZone(state, { type: "move", by: "ann", unit: "ann", to: { q: to.q, r: to.r } });
        if (!step.ok) {
          refused += 1;
          expect(seen, `seed ${seed} step ${i}: shown a walk the server refused (${step.error})`).toBeNull();
        } else {
          if (seen) {
            shown += 1;
            expect(seen.path.length).toBeGreaterThan(0);
            expect(walkedBy(step.events).slice(0, seen.path.length), `seed ${seed} step ${i}`).toEqual(seen.path);
          }
          state = step.state;
        }
        // In a fight she ends her turn now and then, so the walks are a mix of hers to make and not.
        if (state.encounter) {
          fights += 1;
          if (rng.int(0, 2) === 0) {
            const end = stepZone(state, { type: "end_turn", by: "ann", unit: "ann" });
            if (end.ok) state = end.state;
          }
        }
      }
    }
    // The walk-about really did cover all three: walks shown, walks refused, and walks in a fight.
    expect(shown).toBeGreaterThan(60);
    expect(refused).toBeGreaterThan(5);
    expect(fights).toBeGreaterThan(20);
  });

  it("stops at the first hex where the ground may stop it", () => {
    let state = meadow("ground", { groups: 0, obstacles: 0, elevation: 0 });
    const me = ann(state);
    const far = state.map.tiles.filter((t) => t.biome === "plains" && hexDistance(t, me.pos) === 4)[0];
    const whole = foreseeWalk(zoneView(state, "ann"), "ann", far)!;
    expect(whole.path).toHaveLength(4);
    // Fire on the second hex of the way: the walk shown ends on it, and the server's goes at least that far.
    const paint = stepZone(state, { type: "dev", by: "ann", dev: { op: "paint", kind: "fire", hexes: [whole.path[1]] } });
    if (!paint.ok) throw new Error(paint.error);
    state = paint.state;
    const seen = foreseeWalk(zoneView(state, "ann"), "ann", far);
    const step = stepZone(state, { type: "move", by: "ann", unit: "ann", to: far });
    if (!step.ok) throw new Error(step.error);
    if (seen) {
      const burning = seen.path.findIndex((p) => state.surfaces[`${p.q},${p.r}`]);
      // Either the way goes round the fire, or it is shown only as far as the fire.
      if (burning >= 0) expect(burning).toBe(seen.path.length - 1);
      expect(walkedBy(step.events).slice(0, seen.path.length)).toEqual(seen.path);
    }
  });

  it("is not shown for someone else's hero, or one that is down", () => {
    const state = meadow("other", { groups: 0 });
    const to = state.map.tiles.find((t) => t.biome === "plains" && hexDistance(t, ann(state).pos) === 2)!;
    expect(foreseeWalk(zoneView(state, "bo"), "ann", to)).toBeNull();
    expect(foreseeWalk(zoneView(state, "ann"), "ann", ann(state).pos)).toBeNull();
    ann(state).down = true;
    expect(foreseeWalk(zoneView(state, "ann"), "ann", to)).toBeNull();
  });
});

describe("the state as the client believes it", () => {
  it("is the server's own when nothing is ahead", () => {
    const view = zoneView(meadow("same"), "ann");
    expect(believe(view, [])).toBe(view);
    expect(believe(view, [walkAhead(1, hex(0, 0), [hex(1, 0)], { off: true })])).toBe(view);
  });

  it("stands a hero at the end of their shown walks, and leaves the server's state as it was", () => {
    const view = zoneView(meadow("stand", { groups: 0 }), "ann");
    const was = { ...ann(view).pos };
    const ahead: Ahead[] = [walkAhead(1, was, [hex(5, 5), hex(6, 5)]), walkAhead(2, hex(6, 5), [hex(7, 5)])];
    expect(ann(believe(view, ahead)).pos).toEqual(hex(7, 5));
    expect(standing(ahead).get("ann")).toEqual(hex(7, 5));
    expect(ann(view).pos).toEqual(was);
  });

  it("takes what was spent off the turn: movement and the AP it bought, AP, the turn itself", () => {
    const view = zoneView(meadow("turn", { groups: 0 }), "ann");
    view.encounter = { round: 1, order: ["ann"], init: { ann: 10 }, acting: ["ann"], done: [], budgets: { ann: { ap: 4, move: 1, stride: 2, disengaged: false } }, reacted: [], turnNo: 1, deadline: null };
    // 3 movement: the 1 already bought, and an AP for 2 more.
    const walked = believe(view, [walkAhead(1, ann(view).pos, [hex(5, 5), hex(6, 5)], { cost: 3 })]);
    expect(walked.encounter!.budgets.ann).toMatchObject({ ap: 3, move: 0 });
    const struck = believe(view, [{ n: 1, kind: "act", unit: "ann", cost: 2 }]);
    expect(struck.encounter!.budgets.ann).toMatchObject({ ap: 2, move: 1 });
    const slipped = believe(view, [{ n: 1, kind: "act", unit: "ann", cost: 1, gain: "disengage" }]);
    expect(slipped.encounter!.budgets.ann).toMatchObject({ ap: 3, disengaged: true });
    const ended = believe(view, [{ n: 1, kind: "end", unit: "ann" }]);
    expect(ended.encounter!.done).toEqual(["ann"]);
    // Nothing spent after the turn is ended, and the server's own state untouched by any of it.
    expect(believe(view, [{ n: 1, kind: "end", unit: "ann" }, { n: 2, kind: "act", unit: "ann", cost: 1 }]).encounter!.budgets.ann.ap).toBe(4);
    expect(view.encounter.budgets.ann).toEqual({ ap: 4, move: 1, stride: 2, disengaged: false });
    expect(view.encounter.done).toEqual([]);
  });
});

describe("settling what was shown against the server's answer", () => {
  const from = hex(0, 0);
  const path = [hex(1, 0), hex(2, 0), hex(3, 0)];
  const moved = (...steps: HexPos[]): ZoneEvent => ({ t: "moved", id: "ann", path: steps });

  it("keeps a walk the server made exactly as shown, and says which of its steps are already on screen", () => {
    const told = settle([walkAhead(4, from, path)], 4, true, [moved(...path)]);
    expect(told.ahead).toEqual([]);
    expect(told.walk).toMatchObject({ unit: "ann", kept: 3, back: null });
    expect([...told.walk!.shown]).toEqual([[0, 3]]);
    expect(told.recall).toEqual([]);
  });

  it("keeps it when the server walked on past what was shown, or told it in pieces", () => {
    const on = settle([walkAhead(1, from, path.slice(0, 2))], 1, true, [moved(...path), moved(hex(4, 0))]);
    expect(on.walk).toMatchObject({ kept: 2, back: null });
    expect([...on.walk!.shown]).toEqual([[0, 2]]);
    const strike: ZoneEvent = { t: "reaction", id: "e1", target: "ann" };
    const pieces = settle([walkAhead(1, from, path)], 1, true, [moved(path[0]), strike, moved(path[1], path[2])]);
    expect(pieces.walk).toMatchObject({ kept: 3, back: null });
    expect([...pieces.walk!.shown]).toEqual([[0, 1], [2, 2]]);
  });

  it("cuts a walk back to where the server stopped it", () => {
    const told = settle([walkAhead(1, from, path)], 1, true, [moved(path[0]), { t: "fight_start", units: ["ann", "e1"] }]);
    expect(told.walk).toMatchObject({ kept: 1, back: path[0] });
  });

  it("cuts back to the last step in common when the server went another way", () => {
    const told = settle([walkAhead(1, from, path)], 1, true, [moved(path[0], hex(1, 1), hex(2, 1))]);
    expect(told.walk).toMatchObject({ kept: 1, back: path[0] });
    expect([...told.walk!.shown]).toEqual([[0, 1]]);
  });

  it("puts the hero back where they set off when the server refuses, or answers with no walk at all", () => {
    expect(settle([walkAhead(1, from, path)], 1, false, []).walk).toMatchObject({ kept: 0, back: from });
    expect(settle([walkAhead(1, from, path)], 1, true, []).walk).toMatchObject({ kept: 0, back: from });
  });

  it("calls off every later walk of a hero whose walk did not go as shown, and leaves their answers to be played as told", () => {
    const next = walkAhead(2, path[2], [hex(4, 0)]);
    const act: Ahead = { n: 3, kind: "act", unit: "ann", cost: "action" };
    const told = settle([walkAhead(1, from, path), next, act], 1, false, []);
    expect(told.ahead).toEqual([{ ...next, off: true }, act]);
    expect(standing(told.ahead).size).toBe(0);
    // Its own answer, when it comes, is nothing to settle: the walk is played from the server's events.
    const later = settle(told.ahead, 2, true, [moved(hex(1, 1))]);
    expect(later.walk).toBeNull();
    expect(later.ahead).toEqual([act]);
  });

  it("leaves another hero's walks alone", () => {
    const theirs: WalkAhead = { ...walkAhead(2, hex(9, 9), [hex(9, 8)]), unit: "standin" };
    const told = settle([walkAhead(1, from, path), theirs], 1, false, []);
    expect(told.ahead).toEqual([theirs]);
  });

  it("gives up as lost anything sent before the answer that was never answered itself", () => {
    const told = settle([walkAhead(1, from, path), walkAhead(2, path[2], [hex(4, 0)]), { n: 3, kind: "act", unit: "ann", cost: "action" }], 3, true, []);
    expect(told.ahead).toEqual([]);
    expect(told.recall).toEqual([{ unit: "ann", to: from }]);
    expect(told.walk).toBeNull();
  });

  it("settles an action that was not a walk by simply dropping it", () => {
    const act: Ahead = { n: 7, kind: "act", unit: "ann", cost: "action", named: true };
    const told = settle([act], 7, true, [{ t: "used", id: "ann", what: "bash", name: "Bash" }]);
    expect(told).toMatchObject({ ahead: [], entry: act, walk: null, recall: [] });
  });

  it("is unmoved by an answer to something it was not waiting on", () => {
    const ahead = [walkAhead(5, from, path)];
    expect(settle(ahead, 2, true, []).ahead).toEqual(ahead);
  });

  it("gives everything up at once, each hero back to where their first walk set off", () => {
    const ahead: Ahead[] = [walkAhead(1, from, path), walkAhead(2, path[2], [hex(4, 0)]), { n: 3, kind: "end", unit: "ann" }];
    expect(giveUp(ahead)).toEqual([{ unit: "ann", to: from }]);
  });
});
