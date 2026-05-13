import { describe, expect, it } from "vitest";

import {
  createCombatState,
  MONSTER_ID,
  step,
  type CombatEvent,
  type CombatInit,
  type CombatState,
  type RollFn,
  type TurnAction,
} from "./combat_machine";

// Sequence-RNG: returns the next number from a fixed list. Tests must pass
// enough values to cover every roll the engine will request — see comments
// in each test for the order (target pick, d20 hit, damage die).
function seqRoll(seq: number[]): RollFn {
  let i = 0;
  return (sides: number) => {
    if (i >= seq.length) {
      throw new Error(`seqRoll: ran out of values (consumed ${i}, need d${sides})`);
    }
    const v = seq[i++];
    if (v < 1 || v > sides) {
      throw new Error(`seqRoll: value ${v} out of range for d${sides}`);
    }
    return v;
  };
}

function baseInit(overrides: Partial<CombatInit> = {}): CombatInit {
  return {
    fighters: [
      {
        id: "U_PALADIN",
        name: "Edmund",
        class: "QA Paladin",
        level: 5,
        hp: 30,
        max_hp: 30,
        mana: 3,
        max_mana: 3,
        shield: 0,
        position: "front",
        attack_mod: 2,
        magic_mod: 0,
        weapon_power: 4,
        armor_power: 3,
      },
    ],
    monster: {
      name: "The Schemaless Shrieker",
      hp: 40,
      max_hp: 40,
      tier: 3,
      is_boss: false,
    },
    ...overrides,
  };
}

function runBegin(state: CombatState, initiatives: number[]) {
  return step(state, { kind: "begin" }, seqRoll(initiatives));
}

// AC reference (tier 3): monster AC = 13, fighter AC = 10.
// Paladin attack_mod = 2 → needs d20 ≥ 11 to hit. Monster tier 3 → needs ≥ 7.

describe("combat_machine.step", () => {
  describe("begin", () => {
    it("rolls initiative for every fighter and the monster, sorts highest first", () => {
      const init = baseInit({
        fighters: [
          ...baseInit().fighters,
          {
            id: "U_BARD",
            name: "Lyric",
            class: "Frontend Bard",
            level: 4,
            hp: 20,
            max_hp: 20,
            mana: 4,
            max_mana: 4,
            shield: 0,
            position: "back",
            attack_mod: 0,
            magic_mod: 2,
            weapon_power: 2,
            armor_power: 1,
          },
        ],
      });
      // Paladin: 18, Bard: 5, Monster: 12.
      const result = runBegin(createCombatState(init), [18, 5, 12]);
      expect(result.state.status).toBe("active");
      expect(result.state.turn_order).toEqual(["U_PALADIN", MONSTER_ID, "U_BARD"]);
      expect(result.state.round).toBe(1);
      expect(result.events.find((e) => e.type === "begin")).toBeDefined();
      expect(result.events.find((e) => e.type === "turn_start")).toEqual({
        type: "turn_start",
        actor: "U_PALADIN",
        round: 1,
      });
    });

    it("rejects begin if combat is already active", () => {
      const s1 = runBegin(createCombatState(baseInit()), [10, 5]);
      const s2 = step(s1.state, { kind: "begin" }, seqRoll([10, 5]));
      expect(s2.events.some((e) => e.type === "rejected")).toBe(true);
      expect(s2.state).toEqual(s1.state);
    });
  });

  describe("attack (hit + damage)", () => {
    it("damages the monster on hit, emits hit_check + roll + player_hit", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      // d20=15 (+2 = 17 vs AC 13: HIT). d6=4 → damage = (4+2+4) = 10.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([15, 4]),
      );
      expect(result.state.monster.hp).toBe(30); // 40 - 10
      expect(eventTypes(result.events)).toEqual([
        "roll",
        "hit_check",
        "roll",
        "player_hit",
        "turn_start",
      ]);
      const check = result.events.find((e) => e.type === "hit_check");
      expect(check).toMatchObject({ hit: true, total: 17, ac: 13 });
      const hit = result.events.find((e) => e.type === "player_hit");
      expect(hit).toMatchObject({ damage: 10, crit: false });
    });

    it("misses on a low d20, emits hit_check with hit:false, no damage", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      // d20=5 (+2 = 7 vs AC 13: MISS). No damage roll consumed.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([5]),
      );
      expect(result.state.monster.hp).toBe(40);
      expect(eventTypes(result.events)).toEqual([
        "roll",
        "hit_check",
        "turn_start",
      ]);
      const check = result.events.find((e) => e.type === "hit_check");
      expect(check).toMatchObject({ hit: false, total: 7, ac: 13 });
      expect(result.events.find((e) => e.type === "player_hit")).toBeUndefined();
    });

    it("crits on max damage die (1d6 → 6 doubles damage)", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      // d20=12 (hit, 12+2=14 ≥ 13). d6=6 → crit, damage = (6+2+4)*2 = 24.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([12, 6]),
      );
      expect(result.state.monster.hp).toBe(40 - 24);
      const hit = result.events.find((e) => e.type === "player_hit");
      expect(hit).toMatchObject({ damage: 24, crit: true });
    });

    it("rejects out-of-turn attacks (no rolls consumed)", () => {
      const begun = runBegin(createCombatState(baseInit()), [5, 18]); // monster first
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([20, 6]),
      );
      expect(result.events.find((e) => e.type === "rejected")).toBeDefined();
      expect(result.state).toEqual(begun.state);
    });

    it("ends combat with victory when monster dies", () => {
      const init = baseInit();
      init.monster.hp = 5;
      init.monster.max_hp = 5;
      const begun = runBegin(createCombatState(init), [15, 8]);
      // d20=20 hit, d6=6 crit → 24 damage > 5 hp.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([20, 6]),
      );
      expect(result.state.status).toBe("victory");
      expect(result.state.monster.hp).toBe(0);
      const types = eventTypes(result.events);
      expect(types).toContain("monster_down");
      expect(types).toContain("victory");
      expect(types).not.toContain("turn_start");
    });
  });

  describe("monster_act (hit + damage)", () => {
    it("attacks the alive party member on hit, applies armor + position", () => {
      const begun = runBegin(createCombatState(baseInit()), [5, 18]); // monster first
      // pickMonsterTarget consumes roll(101)/100 → 50 = 0.5 (front target).
      // d20=15 (+3 = 18 vs AC 10: HIT).
      // resolveMonsterHit: roll d4=3 → raw=3+3+0=6. armor=floor(3/2)=1 → final=5.
      // position front → 5. shield 0 → hp 30 → 25.
      const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 3]));
      expect(result.state.fighters[0].hp).toBe(25);
      const types = eventTypes(result.events);
      expect(types).toContain("hit_check");
      expect(types).toContain("monster_attack");
    });

    it("misses on a low d20, no damage applied", () => {
      const begun = runBegin(createCombatState(baseInit()), [5, 18]);
      // d20=3 (+3 = 6 vs AC 10: MISS).
      const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 3]));
      expect(result.state.fighters[0].hp).toBe(30);
      const check = result.events.find((e) => e.type === "hit_check");
      expect(check).toMatchObject({ hit: false, total: 6, ac: 10 });
      expect(result.events.find((e) => e.type === "monster_attack")).toBeUndefined();
    });

    it("declares defeat when the last fighter falls on a hit", () => {
      const init = baseInit();
      init.fighters[0].hp = 2;
      init.fighters[0].armor_power = 0;
      const begun = runBegin(createCombatState(init), [5, 18]);
      // target pick=50, d20=15 hit, d4=4 → raw=4+3+0=7. armor 0, final=7. hp 2 → 0.
      const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 4]));
      expect(result.state.status).toBe("defeat");
      expect(result.state.fighters[0].hp).toBe(0);
      const types = eventTypes(result.events);
      expect(types).toContain("fighter_down");
      expect(types).toContain("defeat");
    });

    it("rejects monster_act when it isn't the monster's turn", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 3]));
      expect(result.events.find((e) => e.type === "rejected")).toBeDefined();
    });
  });

  describe("boss phase transition", () => {
    it("flips to phase 2 when HP crosses 50% on the killing chip", () => {
      const init = baseInit();
      init.monster.hp = 21;
      init.monster.max_hp = 40; // 50% threshold = 20
      init.monster.is_boss = true;
      const begun = runBegin(createCombatState(init), [15, 8]);
      // d20=15 hit, d6=4 → damage 10, newHp 11, crosses below 20.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([15, 4]),
      );
      expect(result.state.monster.boss_phase).toBe(2);
      expect(eventTypes(result.events)).toContain("boss_phase_transition");
    });
  });

  describe("turn cycling", () => {
    it("loops back to the first actor and increments round", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]); // paladin → monster
      const after1 = step(begun.state, { kind: "wait", actor: "U_PALADIN" }, seqRoll([]));
      expect(after1.state.turn_order[after1.state.turn_index % 2]).toBe(MONSTER_ID);
      // Monster acts: target=50, d20=15 hit, d4=1 → raw=1+3=4, armor=floor(3/2)=1, final=3.
      const after2 = step(after1.state, { kind: "monster_act" }, seqRoll([50, 15, 1]));
      expect(after2.state.round).toBe(2);
      const startEvt = after2.events.find((e) => e.type === "turn_start") as Extract<
        CombatEvent,
        { type: "turn_start" }
      >;
      expect(startEvt.actor).toBe("U_PALADIN");
      expect(startEvt.round).toBe(2);
    });
  });

  describe("post-combat actions", () => {
    it("rejects further actions after victory", () => {
      const init = baseInit();
      init.monster.hp = 1;
      init.monster.max_hp = 1;
      const begun = runBegin(createCombatState(init), [15, 8]);
      // d20=15 hit, d6=1 → damage 7 > 1.
      const won = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([15, 1]),
      );
      expect(won.state.status).toBe("victory");
      const after = step(
        won.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([15, 5]),
      );
      expect(after.events.find((e) => e.type === "rejected")).toBeDefined();
    });
  });

  describe("heal", () => {
    it("restores HP up to max, emits heal_applied", () => {
      const init = baseInit();
      init.fighters[0].hp = 10;
      init.fighters[0].magic_mod = 1; // re-purpose paladin's magic mod for the test
      const begun = runBegin(createCombatState(init), [15, 8]);
      // d6=4 → heal = 4 + 1 = 5.
      const result = step(
        begun.state,
        { kind: "heal", actor: "U_PALADIN", target: "U_PALADIN" },
        seqRoll([4]),
      );
      expect(result.state.fighters[0].hp).toBe(15);
      const heal = result.events.find((e) => e.type === "heal_applied");
      expect(heal).toMatchObject({ amount: 5, rolled: 5 });
    });

    it("clamps to max_hp; reports actual applied vs rolled", () => {
      const init = baseInit();
      init.fighters[0].hp = 28; // max 30
      const begun = runBegin(createCombatState(init), [15, 8]);
      const result = step(
        begun.state,
        { kind: "heal", actor: "U_PALADIN", target: "U_PALADIN" },
        seqRoll([6]),
      );
      const heal = result.events.find((e) => e.type === "heal_applied");
      // Paladin magic_mod=0 → rolled=6, applied=2.
      expect(heal).toMatchObject({ amount: 2, rolled: 6 });
      expect(result.state.fighters[0].hp).toBe(30);
    });

    it("rejects healing a downed target", () => {
      const init = baseInit();
      init.fighters[0].hp = 0;
      const begun = runBegin(createCombatState(init), [15, 8]);
      const result = step(
        begun.state,
        { kind: "heal", actor: "U_PALADIN", target: "U_PALADIN" },
        seqRoll([4]),
      );
      // Actor is downed so the actor-check rejects first; either way no heal.
      expect(result.events.find((e) => e.type === "rejected")).toBeDefined();
    });
  });

  describe("shield", () => {
    it("adds shield, capped at 2× max_hp", () => {
      const init = baseInit();
      init.fighters[0].shield = 0;
      const begun = runBegin(createCombatState(init), [15, 8]);
      const result = step(
        begun.state,
        { kind: "shield", actor: "U_PALADIN", target: "U_PALADIN" },
        seqRoll([4]),
      );
      expect(result.state.fighters[0].shield).toBe(4);
    });
  });

  describe("signature", () => {
    it("spends 1 mana, damages monster via class-specific dice", () => {
      const init = baseInit();
      init.fighters[0].class = "QA Paladin"; // Smite: 2d6 + atk×2 + weapon
      init.fighters[0].mana = 2;
      const begun = runBegin(createCombatState(init), [15, 8]);
      // 2d6 → 4 + 3 = 7. atk_mod 2 × 2 = 4. weapon 4. damage = 7 + 4 + 4 = 15.
      const result = step(
        begun.state,
        { kind: "signature", actor: "U_PALADIN" },
        seqRoll([4, 3]),
      );
      expect(result.state.fighters[0].mana).toBe(1);
      expect(result.state.monster.hp).toBe(40 - 15);
      const sig = result.events.find((e) => e.type === "signature_used");
      expect(sig).toMatchObject({ damage: 15, mana_spent: 1 });
    });

    it("rejects when mana is 0", () => {
      const init = baseInit();
      init.fighters[0].mana = 0;
      const begun = runBegin(createCombatState(init), [15, 8]);
      const result = step(
        begun.state,
        { kind: "signature", actor: "U_PALADIN" },
        seqRoll([4, 3]),
      );
      expect(result.events.find((e) => e.type === "rejected")).toBeDefined();
      expect(result.state.monster.hp).toBe(40);
    });
  });

  describe("flee", () => {
    it("ends combat with status 'fled' on a successful d20 check", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      // DC = 10 + 3 = 13. Paladin atk_mod 2, mag_mod 0 → mod 2. d20=15 → 17 ≥ 13.
      const result = step(
        begun.state,
        { kind: "flee", actor: "U_PALADIN" },
        seqRoll([15]),
      );
      expect(result.state.status).toBe("fled");
      const fc = result.events.find((e) => e.type === "flee_check");
      expect(fc).toMatchObject({ success: true });
    });

    it("on failure takes a free monster hit and advances turn", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      // d20=5 + 2 = 7 < 13 → fail. Then resolveMonsterHit: d4=3 + tier 3 + 0 = 6. armor 0 → 6.
      const result = step(
        begun.state,
        { kind: "flee", actor: "U_PALADIN" },
        seqRoll([5, 3]),
      );
      expect(result.state.status).toBe("active");
      expect(result.state.fighters[0].hp).toBe(30 - 6);
      const fc = result.events.find((e) => e.type === "flee_check");
      expect(fc).toMatchObject({ success: false });
      expect(result.events.find((e) => e.type === "monster_attack")).toBeDefined();
    });
  });
});

function eventTypes(events: CombatEvent[]): string[] {
  return events.map((e) => e.type);
}

// Type smoke check.
const _unused: TurnAction = { kind: "begin" };
void _unused;
