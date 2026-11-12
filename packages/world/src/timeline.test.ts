// The speed timeline, enemy intents, the free potion and the timeline statuses
// (slowed, hasted, glitched, exposed).

import { describe, expect, it } from "vitest";
import {
  ENEMIES,
  EXPOSED_BONUS,
  POTION_HEAL,
  createBattle,
  makeRng,
  stepBattle,
  turnDelay,
  upcomingTurns,
  upgradeBattle,
  type BattleState,
  type Combatant,
} from "./index";

const fighter = (id: string, over: Partial<Combatant> = {}): Combatant => ({
  id, side: "hero", name: id, kind: "qa_paladin", level: 1, hp: 60, maxHp: 60, pct: { str: 100, int_stat: 100, vit: 100, agi: 100, dex: 100 },
  power: 0, armor: 0, speed: 50, focus: 3, potions: 2, abilities: ["smite", "shield_wall", "cleave", "taunt", "manifest", "encore", "thornlash", "hex"], effects: [], down: false, ...over,
});
const setup = (heroes: Combatant[], enemyKinds: string[], seed = 3) =>
  createBattle({ heroes, enemyKinds, avgLevel: 1, poiId: null }, makeRng(seed));
const enemy = (s: BattleState, id = "e0") => s.combatants.find((c) => c.id === id)!;
const must = (r: ReturnType<typeof stepBattle>) => {
  if (!r.ok) throw new Error(r.error);
  return r;
};

describe("speed timeline", () => {
  it("waits less between turns the faster you are", () => {
    expect(turnDelay({ speed: 75 })).toBeLessThan(turnDelay({ speed: 30 }));
    expect(turnDelay({ speed: 30 }) / turnDelay({ speed: 75 })).toBeCloseTo(115 / 70, 5);
  });

  it("gives a fast combatant more turns than a slow one", () => {
    // A hero at speed 100 against a dummy at 0: about 140/40 = 3.5 hero turns per dummy turn.
    let { state } = setup([fighter("h", { speed: 100, hp: 999, maxHp: 999 })], ["dummy"], 1);
    state = { ...state, combatants: state.combatants.map((c) => (c.side === "enemy" ? { ...c, hp: 999, maxHp: 999 } : c)) };
    const rng = makeRng(2);
    let heroTurns = 0;
    let dummyTurns = 0;
    for (let i = 0; i < 40; i++) {
      const r = must(stepBattle(state, "h", { type: "ability", ability: "shield_wall" }, rng));
      heroTurns += 1;
      dummyTurns += r.events.filter((e) => e.t === "turn" && e.id === "e0").length;
      state = r.state;
    }
    expect(heroTurns / Math.max(1, dummyTurns)).toBeGreaterThan(2.8);
    expect(heroTurns / Math.max(1, dummyTurns)).toBeLessThan(4.2);
  });

  it("is the same fight from the same seed", () => {
    const a = setup([fighter("h1"), fighter("h2", { speed: 70 })], ["wolf", "bandit"], 8);
    const b = setup([fighter("h1"), fighter("h2", { speed: 70 })], ["wolf", "bandit"], 8);
    expect(a.state).toEqual(b.state);
    expect(a.events).toEqual(b.events);
  });

  it("projects the coming turns, starting with whoever is acting", () => {
    const { state } = setup([fighter("h", { speed: 100 })], ["dummy"], 4);
    const next = upcomingTurns(state, 8);
    expect(next).toHaveLength(8);
    expect(next[0].id).toBe(state.actor);
    expect(next.filter((t) => t.id === "h").length).toBeGreaterThan(next.filter((t) => t.id === "e0").length);
  });

  it("brings a fight saved under the old turn order onto the timeline", () => {
    const { state } = setup([fighter("h1"), fighter("h2")], ["bandit"], 5);
    const old = { ...state, order: ["h2", "e0", "h1"], turn: 0, round: 3 } as unknown as BattleState & { order: string[] };
    delete (old as { turnNo?: number }).turnNo;
    for (const c of old.combatants) delete c.next;
    const up = upgradeBattle(old, makeRng(1));
    expect(up.actor).toBe("h2");
    expect(up.turnNo).toBe(1);
    expect(up.combatants.every((c) => typeof c.next === "number")).toBe(true);
    expect(enemy(up).intent).toBeTruthy();
    expect(must(stepBattle(old, "h2", { type: "ability", ability: "smite", target: "e0" }, makeRng(1))).state.turnNo).toBeGreaterThan(1);
  });
});

describe("enemy intents", () => {
  it("every living enemy has a move picked, and it carries that move out", () => {
    let { state } = setup([fighter("h1", { speed: 0, hp: 999, maxHp: 999 }), fighter("h2", { speed: 0, hp: 999, maxHp: 999 })], ["brute", "archer"], 6);
    const rng = makeRng(3);
    for (let i = 0; i < 12 && state.status === "active"; i++) {
      for (const e of state.combatants.filter((c) => c.side === "enemy" && !c.down)) expect(e.intent).toBeTruthy();
      const planned = new Map(state.combatants.filter((c) => c.side === "enemy").map((c) => [c.id, c.intent]));
      const r = must(stepBattle(state, state.actor!, { type: "ability", ability: "shield_wall" }, rng));
      // Each enemy check is the attack it said it would make (unless a stun made it re-plan first).
      for (const ev of r.events) {
        if (ev.t !== "check" || !planned.has(ev.actor)) continue;
        const plan = planned.get(ev.actor)!;
        const kind = enemy(state, ev.actor).kind;
        expect(ev.check.label.replace(" (glitched)", "")).toBe(ENEMIES[kind].attacks[plan!.attack].name);
        planned.delete(ev.actor);
      }
      state = r.state;
    }
  });

  it("hits the hero it named", () => {
    for (let seed = 1; seed < 30; seed++) {
      const { state } = setup([fighter("h1", { speed: 0, hp: 999, maxHp: 999 }), fighter("h2", { speed: 0, hp: 999, maxHp: 999 })], ["brute"], seed);
      const intent = enemy(state).intent!;
      const r = must(stepBattle(state, state.actor!, { type: "ability", ability: "shield_wall" }, makeRng(seed)));
      const hit = r.events.find((e) => (e.t === "hit" || e.t === "miss") && e.actor === "e0");
      if (hit && (hit.t === "hit" || hit.t === "miss") && intent.target) expect(hit.target).toBe(intent.target);
    }
  });

  it("a taunt pulls the named attack onto the taunter", () => {
    let pulled = 0;
    for (let seed = 1; seed < 40; seed++) {
      const { state } = setup([fighter("w", { speed: 0, hp: 999, maxHp: 999 }), fighter("s", { speed: 0, hp: 999, maxHp: 999 })], ["brute"], seed);
      if (state.actor !== "w" || enemy(state).intent?.target !== "s") continue;
      const r = must(stepBattle(state, "w", { type: "ability", ability: "taunt", target: "e0", focus: 2 }, makeRng(seed)));
      const hits = r.events.filter((e) => (e.t === "hit" || e.t === "miss") && e.actor === "e0");
      // The next swing goes to the taunter (later ones may not: a stun can end the taunt early).
      const h = hits[0];
      if (h && (h.t === "hit" || h.t === "miss")) expect(h.target).toBe("w");
      if (hits.length) pulled += 1;
    }
    expect(pulled).toBeGreaterThan(0);
  });

  it("a stunned enemy picks a new move after losing its turn", () => {
    const { state } = setup([fighter("h", { speed: 0 })], ["guardian"], 2);
    // Stun it by hand and let its turn come round.
    const s: BattleState = structuredClone(state);
    enemy(s).effects.push({ kind: "stunned", turns: 1 });
    const r = must(stepBattle(s, s.actor!, { type: "ability", ability: "shield_wall" }, makeRng(4)));
    const skip = r.events.findIndex((e) => e.t === "skip" && e.id === "e0");
    expect(skip).toBeGreaterThanOrEqual(0);
    expect(r.events[skip + 1]).toMatchObject({ t: "intent", id: "e0" });
  });
});

describe("free potion", () => {
  it("heals without ending the turn, once per turn, and can go to an ally", () => {
    const { state } = setup([fighter("a", { hp: 10 }), fighter("b", { hp: 10 })], ["dummy"], 3);
    const me = state.actor!;
    const ally = me === "a" ? "b" : "a";
    const drink = must(stepBattle(state, me, { type: "potion", target: ally }, makeRng(1)));
    expect(drink.state.actor).toBe(me);
    expect(drink.state.turnNo).toBe(state.turnNo);
    expect(drink.state.combatants.find((c) => c.id === ally)!.hp).toBe(10 + POTION_HEAL);
    expect(drink.state.combatants.find((c) => c.id === me)!.potions).toBe(1);
    expect(stepBattle(drink.state, me, { type: "potion" }, makeRng(1)).ok).toBe(false);
    const act = must(stepBattle(drink.state, me, { type: "ability", ability: "smite", target: "e0" }, makeRng(1)));
    expect(act.state.turnNo).toBeGreaterThan(state.turnNo);
  });

  it("can't go to an enemy or a downed hero", () => {
    const { state } = setup([fighter("a"), fighter("b", { hp: 0 })], ["dummy"], 3);
    expect(stepBattle(state, "a", { type: "potion", target: "e0" }, makeRng(1)).ok).toBe(false);
    expect(stepBattle(state, "a", { type: "potion", target: "b" }, makeRng(1)).ok).toBe(false);
  });
});

describe("timeline statuses", () => {
  it("slowed pushes the target's waiting turn back", () => {
    const { state } = setup([fighter("h", { speed: 100 })], ["guardian"], 3);
    const before = enemy(state).next!;
    // Thornlash at 100% is always perfect: slowed for 2.
    const r = must(stepBattle(state, "h", { type: "ability", ability: "thornlash", target: "e0" }, makeRng(1)));
    expect(r.events).toContainEqual({ t: "effect", target: "e0", effect: "slowed", turns: 2 });
    const g = enemy(r.state);
    if (r.events.every((e) => !(e.t === "turn" && e.id === "e0"))) {
      expect(g.next!).toBeCloseTo(before + turnDelay(g) * 0.5, 5);
      expect(g.effects).toContainEqual({ kind: "slowed", turns: 1 });
    }
  });

  it("hasted brings an ally's waiting turn forward, and the Bard's Second Wind gives it", () => {
    const { state } = setup([fighter("a", { speed: 100, hp: 20 }), fighter("b", { speed: 0, hp: 20 })], ["dummy"], 3);
    if (state.actor !== "a") return;
    const before = state.combatants.find((c) => c.id === "b")!.next!;
    const r = must(stepBattle(state, "a", { type: "ability", ability: "encore", target: "b" }, makeRng(1)));
    expect(r.events).toContainEqual({ t: "effect", target: "b", effect: "hasted", turns: 1 });
    const b = r.state.combatants.find((c) => c.id === "b")!;
    if (r.state.actor !== "b") expect(b.next!).toBeLessThan(before);
  });

  it("hasted on yourself shortens your own next wait", () => {
    const { state } = setup([fighter("a", { speed: 50, hp: 20 })], ["dummy"], 3);
    const r = must(stepBattle(state, "a", { type: "ability", ability: "encore", target: "a" }, makeRng(1)));
    const a = r.state.combatants.find((c) => c.id === "a")!;
    if (r.state.actor === "a") return; // already acting again; the next turn came round
    expect(a.next! - state.clock).toBeCloseTo(turnDelay(a) * (2 / 3), 5);
  });

  it("glitched makes one roll of the next check fail, then wears off", () => {
    const { state } = setup([fighter("h", { speed: 0 })], ["dummy"], 3);
    const s = structuredClone(state);
    s.combatants.find((c) => c.id === "h")!.effects.push({ kind: "glitched", turns: 1 });
    const r = must(stepBattle(s, "h", { type: "ability", ability: "smite", target: "e0" }, makeRng(1)));
    const check = r.events.find((e) => e.t === "check" && e.actor === "h");
    expect(check?.t === "check" && check.check.rolls).toEqual([true, true, false]);
    expect(check?.t === "check" && check.check.perfect).toBe(false);
    expect(r.state.combatants.find((c) => c.id === "h")!.effects.some((e) => e.kind === "glitched")).toBe(false);
  });

  it("Hex's perfect glitches the enemy's next attack", () => {
    const { state } = setup([fighter("h", { speed: 100, hp: 999, maxHp: 999 })], ["brute"], 3);
    const r = must(stepBattle(state, "h", { type: "ability", ability: "hex", target: "e0" }, makeRng(1)));
    expect(r.events).toContainEqual({ t: "effect", target: "e0", effect: "glitched", turns: 1 });
  });

  it("exposed adds to direct hits and not to bleeding", () => {
    const hits = (exposed: boolean) => {
      const { state } = setup([fighter("h", { speed: 100 })], ["dummy"], 3);
      const s = structuredClone(state);
      if (exposed) enemy(s).effects.push({ kind: "exposed", turns: 2 });
      const r = must(stepBattle(s, "h", { type: "ability", ability: "smite", target: "e0" }, makeRng(1)));
      const hit = r.events.find((e) => e.t === "hit" && e.actor === "h");
      return hit?.t === "hit" ? hit.amount : -1;
    };
    expect(hits(true) - hits(false)).toBe(EXPOSED_BONUS);
  });

  it("Manifest's perfect leaves the target exposed", () => {
    const { state } = setup([fighter("h", { speed: 100 })], ["guardian"], 3);
    const r = must(stepBattle(state, "h", { type: "ability", ability: "manifest", target: "e0" }, makeRng(1)));
    expect(r.events).toContainEqual({ t: "effect", target: "e0", effect: "exposed", turns: 2 });
  });
});

describe("the fight log reads in order", () => {
  it("logs the blow before the down it causes, and a failed heal as a miss", async () => {
    const { createBattle, stepBattle, currentActor, makeRng, heroCombatant, gearSheet, DUMMY_KIND } = await import("./index");
    const { STARTING_STATS } = await import("@gantt-quest/core");
    const hero = { id: "b", name: "B", classId: "frontend_bard", level: 1, xp: 0, unspent: 0, base: { ...STARTING_STATS.frontend_bard }, ...gearSheet("frontend_bard", []) };
    let sawDown = false;
    let sawFailedHeal = false;
    for (let seed = 0; seed < 80 && !(sawDown && sawFailedHeal); seed++) {
      const rng = makeRng(seed);
      let { state } = createBattle({ heroes: [heroCombatant(hero)], enemyKinds: ["bandit"], avgLevel: 1, poiId: null }, rng);
      for (let i = 0; i < 40 && state.status === "active"; i++) {
        const actor = currentActor(state)!;
        const heal = i % 3 === 2;
        const res = stepBattle(state, actor.id, heal ? { type: "ability", ability: "encore", target: "b" } : { type: "ability", ability: "dissonance", target: "e0" }, rng);
        if (!res.ok) break;
        res.events.forEach((e, k) => {
          if (e.t === "down") {
            sawDown = true;
            const before = res.events.slice(0, k).reverse().find((x) => (x.t === "hit" || x.t === "tick") && x.target === e.id);
            expect(before, "a down follows the blow that caused it").toBeDefined();
          }
          if (e.t === "miss" && e.heal) sawFailedHeal = true;
        });
        state = res.state;
      }
    }
    expect(sawDown).toBe(true);
    expect(sawFailedHeal).toBe(true);
  });
});
