// Nobody is anywhere without having been seen to get there. The client draws a fight from its events alone
// (ZoneView plays them one after another), so every change of a unit's place in a step has to be told by an
// event the client can show: a walk, a leap, a blink, a shove, a fall into a pit. Whatever moves a unit without
// one is seen as a jump from one hex to another with nothing between.
//
// The one thing that does so on purpose is the end of a fight nobody won: lost, the heroes wake at the start
// and the band goes back to its posts; fled, the band goes back to its posts. That is told by `fight_end`.

import { describe, expect, it } from "vitest";
import { hexDistance, type HexPos } from "@gantt-quest/core";
import { moveLeft } from "./combat";
import { zoneOptions } from "./gen";
import { zoneReach } from "./geometry";
import { createZone, standInHero, stepZone } from "./zone";
import type { ZoneAction, ZoneEvent, ZoneState } from "./types";

const same = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
const at = (p: HexPos) => `${p.q},${p.r}`;

/**
 * Follow `events` from where everyone stood before them. Returns where each unit is shown to be at the end,
 * who may be anywhere (`free`: new on the map, hauled out of a pit, or everyone after a fight nobody won), and
 * every walk that skipped ground.
 */
function follow(before: Map<string, HexPos>, events: ZoneEvent[]): { shown: Map<string, HexPos>; free: Set<string>; all: boolean; skips: string[] } {
  const shown = new Map(before);
  const free = new Set<string>();
  const skips: string[] = [];
  let all = false;
  for (const ev of events) {
    if (ev.t === "moved") {
      let from = shown.get(ev.id);
      for (const p of ev.path) {
        if (from && hexDistance(from, p) !== 1) skips.push(`${ev.id} walks from ${at(from)} straight to ${at(p)}`);
        from = p;
      }
      if (from) shown.set(ev.id, from);
    } else if (ev.t === "jumped" || ev.t === "blinked") {
      const from = shown.get(ev.id);
      if (from && !same(from, ev.from)) skips.push(`${ev.id} ${ev.t} from ${at(ev.from)} but stood on ${at(from)}`);
      shown.set(ev.id, ev.to);
    } else if (ev.t === "shoved") {
      const from = shown.get(ev.target);
      if (from && !same(from, ev.from)) skips.push(`${ev.target} shoved from ${at(ev.from)} but stood on ${at(from)}`);
      if (ev.to) shown.set(ev.target, ev.to);
    } else if (ev.t === "sunk" || ev.t === "summoned" || ev.t === "joined" || ev.t === "dismissed") {
      free.add(ev.id);
    } else if (ev.t === "fight_end" && ev.outcome !== "victory") {
      all = true;
    }
  }
  return { shown, free, all, skips };
}

/** Step the zone, and check that the events tell where everyone went. Returns what could not be accounted for. */
function stepSeen(state: ZoneState, action: ZoneAction, events: ZoneEvent[]): { state: ZoneState; unseen: string[] } {
  const res = stepZone(state, action);
  if (!res.ok) return { state, unseen: [] };
  events.push(...res.events);
  const before = new Map(state.units.map((u) => [u.id, u.pos]));
  const { shown, free, all, skips } = follow(before, res.events);
  const unseen = [...skips];
  if (!all) {
    for (const u of res.state.units) {
      const was = before.get(u.id);
      if (!was || free.has(u.id) || u.lost) continue;
      const told = shown.get(u.id)!;
      if (!same(told, u.pos)) unseen.push(`${u.kind} ${u.id} is on ${at(u.pos)} after ${action.type}, but was last shown on ${at(told)} (it stood on ${at(was)}): ${res.events.map((e) => e.t).join(" ")}`);
    }
  }
  return { state: res.state, unseen };
}

describe("where everyone is", () => {
  it("is told by an event whenever it changes: a fight in the open, every band roused, played for rounds", () => {
    let roused = 0;
    let walks = 0;
    for (const site of ["keep", "wilds", "camp"] as const) {
      for (let seed = 0; seed < 4; seed++) {
        let state = createZone("SEEN", `seen-${site}-${seed}`, zoneOptions({ size: "medium", biome: "meadow", site, groups: 5, party: 1, threat: 2 }));
        const joined = stepZone(state, { type: "join", hero: standInHero("qa_paladin", "ann", 3)! });
        if (!joined.ok) throw new Error(joined.error);
        state = joined.state;
        // Hard to kill, so the fight goes on for rounds and every band has the time to walk in.
        const ann = state.units.find((u) => u.id === "ann")!;
        ann.hp = ann.maxHp = 4000;
        const events: ZoneEvent[] = [];
        const unseen: string[] = [];
        const go = (action: ZoneAction) => {
          const res = stepSeen(state, action, events);
          state = res.state;
          unseen.push(...res.unseen.map((line) => `${site} seed ${seed}: ${line}`));
        };
        for (let step = 0; step < 60; step++) {
          const me = state.units.find((u) => u.id === "ann")!;
          const foes = state.units.filter((u) => u.side === "enemy" && !u.down);
          if (foes.length === 0 || me.down) break;
          const enc = state.encounter;
          const fighting = !!enc?.order.includes("ann");
          const mine = !fighting || (enc!.acting.includes("ann") && !enc!.done.includes("ann"));
          if (mine) {
            const target = foes.sort((a, b) => hexDistance(a.pos, me.pos) - hexDistance(b.pos, me.pos))[0];
            const struck = stepZone(state, { type: "use", by: "ann", unit: "ann", ability: me.abilities[0], target: target.id });
            if (struck.ok) go({ type: "use", by: "ann", unit: "ann", ability: me.abilities[0], target: target.id });
            else {
              const reach = zoneReach(state, me, fighting ? moveLeft(enc!.budgets.ann) : 12);
              const spot = [...reach.values()].filter((r) => r.stop).sort((a, b) => hexDistance(a.pos, target.pos) - hexDistance(b.pos, target.pos) || a.cost - b.cost)[0];
              if (spot && hexDistance(spot.pos, target.pos) < hexDistance(me.pos, target.pos)) go({ type: "move", by: "ann", unit: "ann", to: spot.pos });
            }
          }
          const now = state.encounter;
          if (now?.acting.includes("ann") && !now.done.includes("ann")) go({ type: "end_turn", by: "ann", unit: "ann" });
          else if (now && !now.acting.some((id) => !now.done.includes(id))) go({ type: "timeout" });
        }
        expect(unseen, `${site} seed ${seed}`).toEqual([]);
        if (events.some((e) => e.t === "roused")) roused += 1;
        walks += events.filter((e) => e.t === "moved" && e.id !== "ann").length;
      }
    }
    // The fights were real ones: bands were roused, and the enemy did walk.
    expect(roused).toBeGreaterThan(6);
    expect(walks).toBeGreaterThan(100);
  }, 120_000);

  it("is given up only at the end of a fight nobody won, which says so", () => {
    let state = createZone("LOST", "lost-keep", zoneOptions({ size: "medium", biome: "meadow", site: "keep", groups: 5, party: 1, threat: 2 }));
    const joined = stepZone(state, { type: "join", hero: standInHero("qa_paladin", "ann", 1)! });
    if (!joined.ok) throw new Error(joined.error);
    state = joined.state;
    const events: ZoneEvent[] = [];
    const unseen: string[] = [];
    let ended = false;
    for (let step = 0; step < 200 && !ended; step++) {
      const me = state.units.find((u) => u.id === "ann")!;
      const enc = state.encounter;
      const before = events.length;
      let action: ZoneAction;
      if (!enc) {
        const target = state.units.filter((u) => u.side === "enemy" && !u.down).sort((a, b) => hexDistance(a.pos, me.pos) - hexDistance(b.pos, me.pos))[0];
        const spot = [...zoneReach(state, me, 12).values()].filter((r) => r.stop).sort((a, b) => hexDistance(a.pos, target.pos) - hexDistance(b.pos, target.pos) || a.cost - b.cost)[0];
        action = { type: "move", by: "ann", unit: "ann", to: spot.pos };
      } else action = enc.acting.includes("ann") && !enc.done.includes("ann") ? { type: "end_turn", by: "ann", unit: "ann" } : { type: "timeout" };
      const res = stepSeen(state, action, events);
      state = res.state;
      unseen.push(...res.unseen);
      ended = events.slice(before).some((e) => e.t === "fight_end");
    }
    // A hero who only stands there is beaten, and until then everyone's whereabouts were told.
    expect(events.some((e) => e.t === "fight_end" && e.outcome === "defeat")).toBe(true);
    expect(unseen).toEqual([]);
  }, 60_000);
});
