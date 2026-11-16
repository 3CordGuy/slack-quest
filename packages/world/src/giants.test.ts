// Ogres and trolls. The ogre is the heaviest thing that walks ashore: it roams
// and holds camps. The troll grows back every turn unless it is Burning: it
// holds island camps and lies up alone in a cave chamber.

import { describe, expect, it } from "vitest";
import { STARTING_STATS } from "@gantt-quest/core";
import {
  ENEMIES,
  ENEMY_DROPS,
  LURKERS,
  ROAMER_LEADS,
  TROLL_REGEN,
  bandKinds,
  battleDrops,
  createBattle,
  currentActor,
  heroCombatant,
  makeRng,
  stepBattle,
  type BattleEvent,
  type BattleState,
  type HeroSheet,
} from "./index";
import { CAVE_SIM_ENCOUNTERS, SIM_ENCOUNTERS } from "./balance";

const warden: HeroSheet = { id: "h1", name: "H1", classId: "sre_warden", level: 1, base: { ...STARTING_STATS.sre_warden }, bonus: {}, weapon: "pager_axe", weaponPower: 0, armor: 0 };

/**
 * A warden who only ever guards, against one troll, until the troll has had `turns` turns. `before` sets the
 * troll up ahead of every step (wounded, on fire). Returns every event from the troll's turns.
 */
function standOff(seed: number, turns: number, before: (troll: BattleState["combatants"][number]) => void): BattleEvent[] {
  const rng = makeRng(seed);
  const hero = { ...heroCombatant(warden), hp: 999, maxHp: 999 };
  let { state } = createBattle({ heroes: [hero], enemyKinds: ["troll"], avgLevel: 1, poiId: null }, rng);
  const seen: BattleEvent[] = [];
  for (let guard = 0; guard < 60 && seen.filter((e) => e.t === "turn" && e.id === "e0").length < turns; guard++) {
    state = structuredClone(state);
    before(state.combatants.find((c) => c.id === "e0")!);
    const res = stepBattle(state, currentActor(state)!.id, { type: "ability", ability: "hold_the_line" }, rng);
    if (!res.ok) throw new Error(res.error);
    // The troll's part of the step: from where its turn comes up.
    seen.push(...res.events.filter((e) => ("target" in e && e.target === "e0") || ("id" in e && e.id === "e0")));
    state = res.state;
  }
  return seen;
}

describe("the ogre", () => {
  it("is the slowest, toughest rank-and-file there is, and its club hits hardest", () => {
    const { ogre, bear, brute } = ENEMIES;
    expect(ogre.boss).toBeFalsy();
    expect(ogre.hp).toBeGreaterThan(bear.hp);
    expect(ogre.speed).toBeLessThan(bear.speed);
    const rank = Object.values(ENEMIES).filter((e) => !e.boss && e.kind !== "dummy");
    expect(Math.max(...ogre.attacks.map((a) => a.damage))).toBe(Math.max(...rank.flatMap((e) => e.attacks.map((a) => a.damage))));
    expect(ogre.attacks.find((a) => a.name === "Club Smash")?.perfect?.effect).toBe("stunned");
    // Its stomp reaches the whole crew, and leaves them slow.
    expect(ogre.attacks.some((a) => a.target === "all_heroes" && a.perfect?.effect === "slowed")).toBe(true);
    expect(ogre.xp).toBeGreaterThan(brute.xp);
  });

  it("roams ashore alone, with its keeper for a full ship", () => {
    expect(ROAMER_LEADS).toContain("ogre");
    expect(bandKinds("ogre", 1)).toEqual(["ogre"]);
    expect(bandKinds("ogre", 3)).toEqual(["ogre"]);
    expect(bandKinds("ogre", 4)).toEqual(["ogre", "bandit"]);
    expect(SIM_ENCOUNTERS.map((e) => e.id)).toEqual(expect.arrayContaining(["band:ogre", "camp:ogre"]));
  });

  it("leaves hide, bone and iron", () => {
    for (let seed = 1; seed <= 50; seed++) for (const k of Object.keys(battleDrops(makeRng(seed), ["ogre"]))) expect(ENEMY_DROPS.ogre).toContain(k);
    expect(ENEMY_DROPS.ogre).toEqual(["fur", "bone", "iron"]);
  });
});

describe("the troll", () => {
  it("regenerates, and fire stops it", () => {
    expect(ENEMIES.troll.regen).toEqual({ amount: TROLL_REGEN, unless: "burning", name: "Regenerate" });
  });

  it("grows back at the start of each of its turns while it is hurt", () => {
    const events = standOff(1, 3, (t) => (t.hp = t.maxHp - 10));
    const heals = events.filter((e) => e.t === "heal");
    expect(heals).toHaveLength(3);
    for (const h of heals) expect(h).toMatchObject({ actor: "e0", target: "e0", amount: TROLL_REGEN, ability: "Regenerate" });
  });

  it("never grows past its full HP", () => {
    expect(standOff(2, 3, () => {}).filter((e) => e.t === "heal")).toEqual([]);
    const topped = standOff(3, 2, (t) => (t.hp = t.maxHp - 1)).filter((e) => e.t === "heal");
    expect(topped.map((h) => (h.t === "heal" ? h.amount : 0))).toEqual([1, 1]);
  });

  it("can't grow back while it is Burning, and burns instead", () => {
    const events = standOff(4, 3, (t) => {
      t.hp = t.maxHp - 10;
      t.effects = [{ kind: "burning", turns: 3 }];
    });
    expect(events.filter((e) => e.t === "heal")).toEqual([]);
    expect(events.filter((e) => e.t === "tick" && e.effect === "burning")).toHaveLength(3);
  });

  it("holds island camps and keeps a cave chamber to itself", () => {
    expect(LURKERS).toContainEqual(["troll"]);
    expect(SIM_ENCOUNTERS.map((e) => e.id)).toContain("camp:troll");
    expect(CAVE_SIM_ENCOUNTERS.map((e) => e.id)).toContain("camp:troll");
    expect(ENEMY_DROPS.troll).toEqual(["bone", "stone"]);
  });
});
