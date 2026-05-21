import { describe, expect, it } from "vitest";

import {
  createCombatState,
  isMonsterActor,
  mergeEffect,
  MONSTER_ID,
  step,
  upgradeCombatState,
  type CombatEvent,
  type CombatInit,
  type CombatMonster,
  type CombatState,
  type MachineStatusEffect,
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
        scars: [],
      },
    ],
    monster: {
      name: "The Schemaless Shrieker",
      hp: 40,
      max_hp: 40,
      shield: 0,
      tier: 3,
      is_boss: false,
    },
    ...overrides,
  };
}

function runBegin(state: CombatState, initiatives: number[]) {
  return step(state, { kind: "begin" }, seqRoll(initiatives));
}

// AC reference (tier 3): monster AC = 9 (8 + floor(3/2)), fighter AC = 10.
// Paladin attack_mod = 2 → needs d20 ≥ 7 to hit. Monster tier 3 → needs ≥ 7.

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
            scars: [],
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
      // d20=15 (+2 = 17 vs AC 9: HIT). d6=4 → damage = (4+2+4) = 10.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([15, 4]),
      );
      expect(result.state.monsters[0].hp).toBe(30); // 40 - 10
      expect(eventTypes(result.events)).toEqual([
        "roll",
        "hit_check",
        "roll",
        "player_hit",
        "turn_start",
      ]);
      const check = result.events.find((e) => e.type === "hit_check");
      expect(check).toMatchObject({ hit: true, total: 17, ac: 9 });
      const hit = result.events.find((e) => e.type === "player_hit");
      expect(hit).toMatchObject({ damage: 10, crit: false });
    });

    it("misses on a low d20, emits hit_check with hit:false, no damage", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      // d20=5 (+2 = 7 vs AC 9: MISS). No damage roll consumed.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([5]),
      );
      expect(result.state.monsters[0].hp).toBe(40);
      expect(eventTypes(result.events)).toEqual([
        "roll",
        "hit_check",
        "turn_start",
      ]);
      const check = result.events.find((e) => e.type === "hit_check");
      expect(check).toMatchObject({ hit: false, total: 7, ac: 9 });
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
      expect(result.state.monsters[0].hp).toBe(40 - 24);
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
      init.monster!.hp = 5;
      init.monster!.max_hp = 5;
      const begun = runBegin(createCombatState(init), [15, 8]);
      // d20=20 hit, d6=6 crit → 24 damage > 5 hp.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([20, 6]),
      );
      expect(result.state.status).toBe("victory");
      expect(result.state.monsters[0].hp).toBe(0);
      const types = eventTypes(result.events);
      expect(types).toContain("monster_down");
      expect(types).toContain("victory");
      expect(types).not.toContain("turn_start");
    });
  });

  describe("monster_act (hit + damage)", () => {
    it("attacks the alive party member on hit, applies armor pool + position", () => {
      const begun = runBegin(createCombatState(baseInit()), [5, 18]); // monster first
      // pickMonsterTarget consumes roll(101)/100 → 50 = 0.5 (front target).
      // d20=15 (+3 = 18 vs AC 10: HIT).
      // resolveMonsterHit: roll d4=3 → raw=3+3+0=6. physical: final=6 (caller handles armor pool).
      // baseInit shield=0 → applyDamageWithShield(6, 0, 30) → hp=24.
      const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 3]));
      expect(result.state.fighters[0].hp).toBe(24);
      const types = eventTypes(result.events);
      expect(types).toContain("hit_check");
      expect(types).toContain("monster_attack");
    });

    it("misses on a low d20, no damage applied", () => {
      const begun = runBegin(createCombatState(baseInit()), [5, 18]);
      // Monster tier=3 → modifier = floor(3/2)+4=5. Fighter level=5 → AC=12.
      // d20=3 → total=8 < AC 12: MISS.
      const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 3]));
      expect(result.state.fighters[0].hp).toBe(30);
      const check = result.events.find((e) => e.type === "hit_check");
      expect(check).toMatchObject({ hit: false, total: 8, ac: 12 });
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

    it("rerolls off a vanished target when a non-vanished fighter exists", () => {
      const init = baseInit({
        fighters: [
          ...baseInit().fighters,
          {
            id: "U_ROGUE",
            name: "Fenel the Deprecated",
            class: "Refactor Rogue",
            level: 4,
            hp: 20,
            max_hp: 20,
            mana: 3,
            max_mana: 3,
            shield: 0,
            position: "back",
            attack_mod: 1,
            magic_mod: 0,
            weapon_power: 3,
            armor_power: 1,
            scars: [],
          },
        ],
      });
      const begun = runBegin(createCombatState(init), [5, 1, 20]);
      const vanishedState = {
        ...begun.state,
        ability_state: { vanished: { U_PALADIN: 2 } },
      };

      const result = step(vanishedState, { kind: "monster_act" }, seqRoll([50, 15, 15, 3]));
      expect(result.state.fighters.find((f) => f.id === "U_PALADIN")?.hp).toBe(30);
      expect(result.state.fighters.find((f) => f.id === "U_ROGUE")?.hp).toBeLessThan(20);
      expect(eventTypes(result.events)).toContain("monster_target_redirected");
      expect(result.events.find((e) => e.type === "monster_target_redirected")).toMatchObject({
        from: "U_PALADIN",
        to: "U_ROGUE",
        reason: "vanish",
      });
    });

    it("blocks the monster swing when all alive fighters are vanished", () => {
      const init = baseInit();
      const begun = runBegin(createCombatState(init), [5, 18]);
      const vanishedState = {
        ...begun.state,
        ability_state: { vanished: { U_PALADIN: 2 } },
      };

      const result = step(vanishedState, { kind: "monster_act" }, seqRoll([50]));
      expect(result.state.fighters[0].hp).toBe(30);
      expect(eventTypes(result.events)).toEqual(["monster_target_blocked", "turn_start"]);
      expect(result.events.find((e) => e.type === "monster_attack")).toBeUndefined();
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
      init.monster!.hp = 21;
      init.monster!.max_hp = 40; // 50% threshold = 20
      init.monster!.is_boss = true;
      const begun = runBegin(createCombatState(init), [15, 8]);
      // d20=15 hit, d6=4 → damage 10, newHp 11, crosses below 20.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([15, 4]),
      );
      expect(result.state.monsters[0].boss_phase).toBe(2);
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
      init.monster!.hp = 1;
      init.monster!.max_hp = 1;
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
      // resolveHeal rolls 2d6: 3+1=4 → amount=max(2,4+1)=5. hp 10→15.
      const result = step(
        begun.state,
        { kind: "heal", actor: "U_PALADIN", target: "U_PALADIN" },
        seqRoll([3, 1]),
      );
      expect(result.state.fighters[0].hp).toBe(15);
      const heal = result.events.find((e) => e.type === "heal_applied");
      expect(heal).toMatchObject({ amount: 5, rolled: 5 });
    });

    it("clamps to max_hp; reports actual applied vs rolled", () => {
      const init = baseInit();
      init.fighters[0].hp = 28; // max 30
      const begun = runBegin(createCombatState(init), [15, 8]);
      // resolveHeal rolls 2d6: 3+3=6 → amount=max(2,6+0)=6. hp would be 34, clamped to 30. applied=2.
      const result = step(
        begun.state,
        { kind: "heal", actor: "U_PALADIN", target: "U_PALADIN" },
        seqRoll([3, 3]),
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

  describe("smite ability (QA Paladin)", () => {
    it("spends 1 mana, damages monster via class-specific dice", () => {
      const init = baseInit();
      init.fighters[0].class = "QA Paladin"; // Smite: 2d6 + atk×2 + weapon
      init.fighters[0].mana = 2;
      const begun = runBegin(createCombatState(init), [15, 8]);
      // 2d6 → 4 + 3 = 7. atk_mod 2 × 2 = 4. weapon 4. damage = 7 + 4 + 4 = 15.
      const result = step(
        begun.state,
        { kind: "ability", actor: "U_PALADIN", ability_id: "smite" },
        seqRoll([4, 3]),
      );
      expect(result.state.fighters[0].mana).toBe(1);
      expect(result.state.monsters[0].hp).toBe(40 - 15);
      const hit = result.events.find((e) => e.type === "player_hit");
      expect(hit).toMatchObject({ damage: 15 });
      const used = result.events.find((e) => e.type === "ability_used");
      expect(used).toMatchObject({ ability_id: "smite", mana_spent: 1 });
    });

    it("rejects when mana is 0", () => {
      const init = baseInit();
      init.fighters[0].class = "QA Paladin";
      init.fighters[0].mana = 0;
      const begun = runBegin(createCombatState(init), [15, 8]);
      const result = step(
        begun.state,
        { kind: "ability", actor: "U_PALADIN", ability_id: "smite" },
        seqRoll([4, 3]),
      );
      expect(result.events.find((e) => e.type === "rejected")).toBeDefined();
      expect(result.state.monsters[0].hp).toBe(40);
    });
  });

  describe("fireball ability (DevOps Mage, AoE)", () => {
    function mageInit(overrides: Partial<CombatInit> = {}): CombatInit {
      const init = baseInit(overrides);
      init.fighters[0].class = "DevOps Mage";
      init.fighters[0].mana = 3;
      init.fighters[0].magic_mod = 1;
      return init;
    }

    it("hits the single monster and spends 2 mana", () => {
      const init = mageInit();
      const begun = runBegin(createCombatState(init), [15, 8]);
      // Fireball: 2d6 + magic_mod(1). Rolls: 4 + 3 = 7 + 1 = 8 damage.
      const result = step(
        begun.state,
        { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
        seqRoll([4, 3]),
      );
      expect(result.state.fighters[0].mana).toBe(1); // 3 - 2 = 1
      const hit = result.events.find((e) => e.type === "player_hit");
      expect(hit).toMatchObject({ damage: 8 });
      const used = result.events.find((e) => e.type === "ability_used");
      expect(used).toMatchObject({ ability_id: "fireball", mana_spent: 2 });
    });

    it("damages ALL monsters with the same roll", () => {
      // Two goblins: 10 HP each.
      const init = mageInit({
        monsters: [
          { name: "Goblin A", hp: 10, max_hp: 10, tier: 1, is_boss: false },
          { name: "Goblin B", hp: 10, max_hp: 10, tier: 1, is_boss: false },
        ],
      });
      const begun = runBegin(createCombatState(init), [15, 10, 5]);
      // 2d6 + 1 → rolls 3 + 2 = 5 + 1 = 6 damage to each.
      const result = step(
        begun.state,
        { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
        seqRoll([3, 2]),
      );
      expect(result.state.monsters[0].hp).toBe(4); // 10 - 6
      expect(result.state.monsters[1].hp).toBe(4);
      const hits = result.events.filter((e) => e.type === "player_hit");
      expect(hits).toHaveLength(2);
    });

    it("emits victory when fireball kills all monsters", () => {
      const init = mageInit({
        monsters: [
          { name: "Goblin A", hp: 3, max_hp: 3, tier: 1, is_boss: false },
          { name: "Goblin B", hp: 3, max_hp: 3, tier: 1, is_boss: false },
        ],
      });
      const begun = runBegin(createCombatState(init), [15, 10, 5]);
      // 2d6 + 1 → 4 + 4 = 8 + 1 = 9 damage. Both die.
      const result = step(
        begun.state,
        { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
        seqRoll([4, 4]),
      );
      expect(result.state.status).toBe("victory");
      expect(result.events.find((e) => e.type === "victory")).toBeDefined();
    });

    it("rejects when mana < 2", () => {
      const init = mageInit();
      init.fighters[0].mana = 1;
      const begun = runBegin(createCombatState(init), [15, 8]);
      const result = step(
        begun.state,
        { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
        seqRoll([4, 3]),
      );
      expect(result.events.find((e) => e.type === "rejected")).toBeDefined();
    });
  });

  describe("gauntlet waves", () => {
    it("transitions to the next wave on monster kill instead of ending combat", () => {
      const init = baseInit();
      init.monster!.hp = 1;
      init.monster!.max_hp = 10;
      init.monster!.wave = 1;
      init.monster!.total_waves = 3;
      init.monster!.upcoming_waves = [
        { name: "Drift Wraith", max_hp: 14 },
        { name: "Schema Hydra", max_hp: 22 },
      ];
      const begun = runBegin(createCombatState(init), [15, 8]);
      // d20=15 hit, d6=1 → damage 7 > 1, monster falls.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([15, 1]),
      );
      expect(result.state.status).toBe("active");
      expect(result.state.monsters[0].name).toBe("Drift Wraith");
      expect(result.state.monsters[0].hp).toBe(14);
      expect(result.state.monsters[0].max_hp).toBe(14);
      expect(result.state.monsters[0].wave).toBe(2);
      expect(result.state.monsters[0].upcoming_waves).toEqual([
        { name: "Schema Hydra", max_hp: 22 },
      ]);
      const types = eventTypes(result.events);
      expect(types).toContain("monster_down");
      expect(types).toContain("wave_transition");
      expect(types).not.toContain("victory");
    });

    it("emits victory after killing the final wave's monster", () => {
      const init = baseInit();
      init.monster!.hp = 1;
      init.monster!.max_hp = 10;
      init.monster!.wave = 3;
      init.monster!.total_waves = 3;
      init.monster!.upcoming_waves = [];
      const begun = runBegin(createCombatState(init), [15, 8]);
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([15, 1]),
      );
      expect(result.state.status).toBe("victory");
      const types = eventTypes(result.events);
      expect(types).toContain("monster_down");
      expect(types).toContain("victory");
      expect(types).not.toContain("wave_transition");
    });
  });

  describe("position", () => {
    it("flips the fighter's row and advances turn", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      const result = step(
        begun.state,
        { kind: "position", actor: "U_PALADIN", to: "back" },
        seqRoll([]),
      );
      expect(result.state.fighters[0].position).toBe("back");
      const evt = result.events.find((e) => e.type === "position_changed");
      expect(evt).toMatchObject({ from: "front", to: "back" });
    });

    it("rejects a no-op position swap", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      const result = step(
        begun.state,
        { kind: "position", actor: "U_PALADIN", to: "front" },
        seqRoll([]),
      );
      expect(result.events.find((e) => e.type === "rejected")).toBeDefined();
    });
  });

  describe("status effect ticks", () => {
    it("ticks monster effects on monster_act; poison damages monster", () => {
      const init = baseInit();
      const begun = runBegin(createCombatState(init), [5, 18]); // monster first
      // Manually inject a poison effect on the monster.
      const withPoison = {
        ...begun.state,
        monsters: begun.state.monsters.map((m) => ({
          ...m,
          effects: [
            { type: "poisoned" as const, magnitude: 3, remaining: 2, source: "U_PALADIN" },
          ],
        })),
      };
      // monster_act consumes target pick (50), d20 hit (15), then damage d4 (1).
      const result = step(withPoison, { kind: "monster_act" }, seqRoll([50, 15, 1]));
      // Monster ticks first: 40 hp - 3 = 37 hp, remaining 2 → 1.
      expect(result.state.monsters[0].hp).toBe(37);
      expect(result.state.monsters[0].effects).toEqual([
        { type: "poisoned", magnitude: 3, remaining: 1, source: "U_PALADIN" },
      ]);
      const tickEvt = result.events.find((e) => e.type === "effect_tick");
      expect(tickEvt).toMatchObject({
        actor: MONSTER_ID,
        effect: "poisoned",
        hp_delta: -3,
        source: "U_PALADIN",
      });
    });

    it("kills the monster on a poison tick and credits the source", () => {
      const init = baseInit();
      init.monster!.hp = 2;
      const begun = runBegin(createCombatState(init), [5, 18]);
      const withPoison = {
        ...begun.state,
        monsters: begun.state.monsters.map((m) => ({
          ...m,
          effects: [
            { type: "burning" as const, magnitude: 5, remaining: 3, source: "U_PALADIN" },
          ],
        })),
      };
      const result = step(withPoison, { kind: "monster_act" }, seqRoll([50, 15, 1]));
      expect(result.state.status).toBe("victory");
      expect(result.state.monsters[0].hp).toBe(0);
      // Source got credit on the contribution counter.
      expect(result.state.contribution.U_PALADIN).toBe(2);
      const types = eventTypes(result.events);
      expect(types).toContain("monster_down");
      expect(types).toContain("victory");
    });

    it("regen on a fighter heals up to max_hp", () => {
      const init = baseInit();
      init.fighters[0].hp = 25; // 5 below max
      const begun = runBegin(createCombatState(init), [15, 8]); // paladin first
      const withRegen = {
        ...begun.state,
        fighters: begun.state.fighters.map((f, i) =>
          i === 0
            ? {
                ...f,
                effects: [{ type: "regen" as const, magnitude: 3, remaining: 2 }],
              }
            : f,
        ),
      };
      const result = step(withRegen, { kind: "wait", actor: "U_PALADIN" }, seqRoll([]));
      expect(result.state.fighters[0].hp).toBe(28);
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

// ─── STATS_V2 behaviors ────────────────────────────────────────────────────

describe("STATS_V2 — DEX crit bonus", () => {
  it("fires a secondary crit when DEX roll beats threshold", () => {
    // DEX=8 → deriveCritBonus = min(10%, (8-5)*1%) = 3%. threshold = 3.
    const init = baseInit();
    (init.fighters[0] as unknown as Record<string, unknown>).stats = {
      str: 5, int_stat: 5, vit: 5, agi: 5, dex: 8,
    };
    const begun = runBegin(createCombatState(init), [15, 8]);
    // Roll order: d20=15 (hit, 15+2=17 vs mAC=9), d6=4 (no nat-crit),
    // roll(100)=2 (≤ 3 threshold → DEX crit).
    const result = step(begun.state, { kind: "attack", actor: "U_PALADIN" }, seqRoll([15, 4, 2]));
    const hit = result.events.find((e) => e.type === "player_hit");
    expect(hit).toBeDefined();
    expect((hit as { crit?: boolean })?.crit).toBe(true);
    // Damage: (4 + attack_mod=2 + weapon=4) * 2 = 20.
    expect((hit as { damage?: number })?.damage).toBe(20);
  });

  it("does not fire when roll exceeds threshold", () => {
    // Same fighter, DEX=8, threshold=3. Roll(100)=5 > 3 → no secondary crit.
    const init = baseInit();
    (init.fighters[0] as unknown as Record<string, unknown>).stats = {
      str: 5, int_stat: 5, vit: 5, agi: 5, dex: 8,
    };
    const begun = runBegin(createCombatState(init), [15, 8]);
    const result = step(begun.state, { kind: "attack", actor: "U_PALADIN" }, seqRoll([15, 4, 5]));
    const hit = result.events.find((e) => e.type === "player_hit");
    expect((hit as { crit?: boolean })?.crit).toBe(false);
    expect((hit as { damage?: number })?.damage).toBe(10); // (4+2+4)*1
  });

  it("skips the DEX roll when stats is absent (no STATS_V2)", () => {
    // baseInit fighter has no stats field — no extra roll consumed.
    const begun = runBegin(createCombatState(baseInit()), [15, 8]);
    // Only d20 + d6 needed — no roll(100). If seqRoll had [15,4] it would error
    // on a third call; we pass exactly two values to prove no extra roll occurs.
    expect(() =>
      step(begun.state, { kind: "attack", actor: "U_PALADIN" }, seqRoll([15, 4])),
    ).not.toThrow();
  });
});

describe("STATS_V2 — AGI dodge", () => {
  it("emits monster_dodged and leaves fighter HP intact", () => {
    // AGI=8 → deriveDodgeChance = (8-5)*1% = 3%. threshold = 3.
    const init = baseInit();
    (init.fighters[0] as unknown as Record<string, unknown>).stats = {
      str: 5, int_stat: 5, vit: 5, agi: 8, dex: 5,
    };
    const begun = runBegin(createCombatState(init), [5, 18]); // monster first
    // Roll order: roll(101)=50 (target pick), d20=15 (hit, 15+5=20 ≥ AC=12),
    // roll(100)=2 (≤ 3 → DODGE). No damage roll.
    const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 2]));
    expect(result.state.fighters[0].hp).toBe(30);
    expect(eventTypes(result.events)).toContain("monster_dodged");
    expect(result.events.find((e) => e.type === "monster_attack")).toBeUndefined();
  });

  it("does not dodge when roll exceeds threshold", () => {
    const init = baseInit();
    (init.fighters[0] as unknown as Record<string, unknown>).stats = {
      str: 5, int_stat: 5, vit: 5, agi: 8, dex: 5,
    };
    const begun = runBegin(createCombatState(init), [5, 18]);
    // roll(100)=5 > 3 → no dodge; then d4=1 for damage.
    const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 5, 1]));
    expect(result.state.fighters[0].hp).toBeLessThan(30);
    expect(eventTypes(result.events)).not.toContain("monster_dodged");
  });

  it("skips the dodge roll when AGI is 5 (threshold = 0)", () => {
    const init = baseInit();
    (init.fighters[0] as unknown as Record<string, unknown>).stats = {
      str: 5, int_stat: 5, vit: 5, agi: 5, dex: 5,
    };
    const begun = runBegin(createCombatState(init), [5, 18]);
    // agi=5 → threshold=0 → roll(100) not called. Only target + d20 + d4.
    expect(() =>
      step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 3])),
    ).not.toThrow();
  });
});

describe("STATS_V2 — VIT armor bonus", () => {
  it("adds VIT-derived armor on top of equipped armor_power (armor pool absorbs)", () => {
    // VIT=9 → deriveArmorBonus = floor((9-5)/4) = 1. armor_power=3 → total=4.
    // resolveMonsterHit: d4=3, tier=3, party=1 → raw=6. physical final=6.
    // Fighter starts with shield=1 (floor(4/2)=2 total pool, but test has shield pre-set at 2 to test absorption).
    // applyDamageWithShield(6, 2, 30) → armor absorbs 2, hp takes 4 → hp=26.
    const init = baseInit();
    (init.fighters[0] as unknown as Record<string, unknown>).stats = {
      str: 5, int_stat: 5, vit: 9, agi: 5, dex: 5,
    };
    // Pre-load armor pool to its max (floor((armor_power=3 + vit_bonus=1)/2) = 2)
    init.fighters[0].shield = 2;
    const begun = runBegin(createCombatState(init), [5, 18]);
    const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 3]));
    expect(result.state.fighters[0].hp).toBe(26); // 30 - (6-2) = 26
    expect(result.state.fighters[0].shield).toBe(0); // armor depleted
  });

  it("without armor pool, full raw damage hits HP", () => {
    // Same d4=3, tier=3. armor_power=3 but shield=0 → full raw=6 hits HP.
    const begun = runBegin(createCombatState(baseInit()), [5, 18]);
    const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 3]));
    expect(result.state.fighters[0].hp).toBe(24); // 30 - 6 = 24
  });
});

function eventTypes(events: CombatEvent[]): string[] {
  return events.map((e) => e.type);
}

// Type smoke check.
const _unused: TurnAction = { kind: "begin" };

// ---------------------------------------------------------------------------

describe("isMonsterActor", () => {
  it("matches the legacy single-monster sentinel", () => {
    expect(isMonsterActor("__monster__")).toBe(true);
  });
  it("matches multi-monster indexed IDs", () => {
    expect(isMonsterActor("__monster_0__")).toBe(true);
    expect(isMonsterActor("__monster_5__")).toBe(true);
  });
  it("does not match a player id", () => {
    expect(isMonsterActor("U_PALADIN")).toBe(false);
    expect(isMonsterActor("U_12345")).toBe(false);
  });
  it("does not match an empty string", () => {
    expect(isMonsterActor("")).toBe(false);
  });
});

describe("upgradeCombatState", () => {
  it("is a no-op when monsters[] is already populated", () => {
    const state = createCombatState(baseInit());
    const upgraded = upgradeCombatState(state);
    expect(upgraded).toBe(state); // same reference
  });

  it("promotes legacy monster to monsters[0] with MONSTER_ID", () => {
    const legacyMonster: CombatMonster = {
      id: MONSTER_ID,
      name: "Stale Wraith",
      hp: 20,
      max_hp: 20,
      shield: 2,
      tier: 2,
      initiative: 0,
      effects: [],
      is_boss: false,
      boss_phase: 1,
    };
    const legacyState: CombatState = {
      fighters: [],
      monsters: [],
      monster: legacyMonster,
      turn_order: [],
      turn_index: 0,
      round: 0,
      status: "pending",
      contribution: {},
      stats: {},
    };
    const upgraded = upgradeCombatState(legacyState);
    expect(upgraded.monsters).toHaveLength(1);
    expect(upgraded.monsters[0].name).toBe("Stale Wraith");
    expect(upgraded.monsters[0].id).toBe(MONSTER_ID);
  });

  it("returns state unchanged when neither monster nor monsters are present", () => {
    const empty: CombatState = {
      fighters: [],
      monsters: [],
      turn_order: [],
      turn_index: 0,
      round: 0,
      status: "pending",
      contribution: {},
      stats: {},
    };
    expect(upgradeCombatState(empty)).toBe(empty);
  });
});

describe("multi-monster combat", () => {
  // Helper: two-monster init. Monsters get IDs __monster_0__ and __monster_1__.
  function twoMonsterInit(overrides: Partial<CombatInit> = {}): CombatInit {
    return {
      fighters: baseInit().fighters,
      monsters: [
        { name: "Goblin A", hp: 5, max_hp: 5, tier: 1, is_boss: false },
        { name: "Goblin B", hp: 8, max_hp: 8, tier: 1, is_boss: false },
      ],
      ...overrides,
    };
  }

  it("assigns __monster_N__ IDs when multiple monsters are present", () => {
    const state = createCombatState(twoMonsterInit());
    expect(state.monsters[0].id).toBe("__monster_0__");
    expect(state.monsters[1].id).toBe("__monster_1__");
  });

  it("single monster still gets the legacy __monster__ ID", () => {
    const state = createCombatState(baseInit());
    expect(state.monsters[0].id).toBe(MONSTER_ID);
  });

  it("turn order includes a slot for each monster", () => {
    // Fighter initiative 15, monster_0 initiative 10, monster_1 initiative 5.
    const begun = runBegin(createCombatState(twoMonsterInit()), [15, 10, 5]);
    expect(begun.state.turn_order).toContain("__monster_0__");
    expect(begun.state.turn_order).toContain("__monster_1__");
    expect(begun.state.turn_order).toContain("U_PALADIN");
    expect(begun.state.turn_order).toHaveLength(3);
  });

  it("attack with target_id damages only the targeted monster", () => {
    // Fighter goes first (initiative 15). Monsters have initiative 10 and 5.
    const begun = runBegin(createCombatState(twoMonsterInit()), [15, 10, 5]);
    // d20=15 hit, d6=4 — Goblin A (hp 5) takes 4+attack_mod(2)+weapon(4)=10 → dies.
    const result = step(
      begun.state,
      { kind: "attack", actor: "U_PALADIN", target_id: "__monster_0__" },
      seqRoll([15, 4]),
    );
    expect(result.state.monsters[0].hp).toBeLessThanOrEqual(0); // Goblin A dead
    expect(result.state.monsters[1].hp).toBe(8);                // Goblin B untouched
  });

  it("combat stays active until ALL monsters are dead", () => {
    const begun = runBegin(createCombatState(twoMonsterInit()), [15, 10, 5]);
    // Kill Goblin A — combat should still be active.
    const after1 = step(
      begun.state,
      { kind: "attack", actor: "U_PALADIN", target_id: "__monster_0__" },
      seqRoll([15, 4]),
    );
    expect(after1.state.status).toBe("active");
    expect(eventTypes(after1.events)).not.toContain("victory");
  });

  it("emits victory only after the last monster falls", () => {
    // Give both monsters 1 HP so one attack kills each.
    const init = twoMonsterInit();
    init.monsters![0].hp = 1;
    init.monsters![1].hp = 1;
    const begun = runBegin(createCombatState(init), [15, 10, 5]);

    // Kill Goblin A — still active.
    const after1 = step(
      begun.state,
      { kind: "attack", actor: "U_PALADIN", target_id: "__monster_0__" },
      seqRoll([15, 1]),
    );
    expect(after1.state.status).toBe("active");

    // Advance past the dead Goblin A's turn and Goblin B's turn to get back to
    // the fighter. seqRoll for monster_act: target pick d101 + d20 hit + d4 dmg.
    // monster_0 is dead so its turn is a no-op pass; monster_1 acts.
    const monB = step(after1.state, { kind: "monster_act" }, seqRoll([50, 5, 1])); // B misses or hits
    // Now it's the fighter's turn again — kill Goblin B.
    const after2 = step(
      monB.state,
      { kind: "attack", actor: "U_PALADIN", target_id: "__monster_1__" },
      seqRoll([15, 1]),
    );
    expect(after2.state.status).toBe("victory");
    expect(eventTypes(after2.events)).toContain("victory");
  });
});

describe("containerize ability (DevOps Mage)", () => {
  function mageInit(overrides: Partial<CombatInit> = {}): CombatInit {
    const init = baseInit(overrides);
    init.fighters[0].class = "DevOps Mage";
    init.fighters[0].mana = 3;
    init.fighters[0].magic_mod = 1;
    return init;
  }

  it("applies stunned effect to the monster with remaining=5", () => {
    const begun = runBegin(createCombatState(mageInit()), [15, 8]);
    // Containerize costs 2 mana, no dice needed.
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "containerize" },
      seqRoll([]),
    );
    expect(result.state.fighters[0].mana).toBe(1); // 3 - 2
    const stunned = result.state.monsters[0].effects.find((e) => e.type === "stunned");
    expect(stunned).toBeDefined();
    expect(stunned?.remaining).toBe(5);
    expect(result.events.find((e) => e.type === "ability_containerize")).toBeDefined();
  });

  it("respects target_id when multiple monsters are present", () => {
    const init = mageInit({
      monsters: [
        { name: "Goblin A", hp: 10, max_hp: 10, tier: 1, is_boss: false },
        { name: "Goblin B", hp: 10, max_hp: 10, tier: 1, is_boss: false },
      ],
    });
    const begun = runBegin(createCombatState(init), [15, 10, 5]);
    // Target Goblin B (__monster_1__) specifically.
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "containerize", target_id: "__monster_1__" },
      seqRoll([]),
    );
    expect(result.state.monsters[0].effects.find((e) => e.type === "stunned")).toBeUndefined();
    expect(result.state.monsters[1].effects.find((e) => e.type === "stunned")).toBeDefined();
  });

  it("stunned monster skips its swing; remaining decremented; no break at 30% threshold miss", () => {
    // Monster goes first. Inject stun with remaining=5 onto the monster.
    const begun = runBegin(createCombatState(mageInit()), [5, 18]);
    const stunnedState = {
      ...begun.state,
      monsters: begun.state.monsters.map((m) => ({
        ...m,
        effects: [{ type: "stunned" as const, magnitude: 0, remaining: 5, source: "U_PALADIN" }],
      })),
    };
    // tickEffects: remaining 5→4. turnsElapsed=1, breakChance=0.30.
    // roll(100)=100 → 1.0, NOT < 0.30 → stun holds.
    const result = step(stunnedState, { kind: "monster_act" }, seqRoll([100]));
    expect(result.state.fighters[0].hp).toBe(30); // fighter untouched
    expect(result.events.find((e) => e.type === "monster_swing_skipped")).toBeDefined();
    expect(result.events.find((e) => e.type === "monster_stun_broken")).toBeUndefined();
    // remaining decremented by tick
    const after = result.state.monsters[0].effects.find((e) => e.type === "stunned");
    expect(after?.remaining).toBe(4);
  });

  it("stun breaks on 4th stunned turn (breakChance=100%, any roll triggers)", () => {
    // Inject stun with remaining=2. After tick: remaining=1, turnsElapsed=4, breakChance=1.0.
    const begun = runBegin(createCombatState(mageInit()), [5, 18]);
    const stunnedState = {
      ...begun.state,
      monsters: begun.state.monsters.map((m) => ({
        ...m,
        effects: [{ type: "stunned" as const, magnitude: 0, remaining: 2, source: "U_PALADIN" }],
      })),
    };
    const result = step(stunnedState, { kind: "monster_act" }, seqRoll([1]));
    expect(result.events.find((e) => e.type === "monster_stun_broken")).toBeDefined();
    expect(result.events.find((e) => e.type === "monster_swing_skipped")).toBeDefined();
    // Stun removed from monster's effects.
    expect(result.state.monsters[0].effects.find((e) => e.type === "stunned")).toBeUndefined();
  });
});

describe("Mana Font passive (DevOps Mage)", () => {
  function mageInit(mana = 1): CombatInit {
    const init = baseInit();
    init.fighters[0].class = "DevOps Mage";
    init.fighters[0].mana = mana;
    init.fighters[0].max_mana = 3;
    init.fighters[0].magic_mod = 1;
    return init;
  }

  it("restores 1 mana on every 3rd action and emits passive_mage_mana_font", () => {
    const begun = runBegin(createCombatState(mageInit(1)), [15, 8]);
    // Pre-seed counter to 2 so the next turn is the 3rd action → fires.
    const withCounter = { ...begun.state, action_counters: { U_PALADIN: 2 } };
    const result = step(withCounter, { kind: "wait", actor: "U_PALADIN" }, seqRoll([]));
    expect(result.state.fighters[0].mana).toBe(2); // 1 + 1
    const evt = result.events.find((e) => e.type === "passive_mage_mana_font");
    expect(evt).toBeDefined();
    expect(evt).toMatchObject({ actor: "U_PALADIN", amount: 1 });
  });

  it("does not fire on non-3rd-multiple turns", () => {
    const begun = runBegin(createCombatState(mageInit(1)), [15, 8]);
    // Counter starts at 0 → first turn is action 1, no fire.
    const result = step(begun.state, { kind: "wait", actor: "U_PALADIN" }, seqRoll([]));
    expect(result.events.find((e) => e.type === "passive_mage_mana_font")).toBeUndefined();
    expect(result.state.fighters[0].mana).toBe(1); // unchanged
  });

  it("does not restore mana when already at max_mana", () => {
    const begun = runBegin(createCombatState(mageInit(3)), [15, 8]); // mana=3=max
    const withCounter = { ...begun.state, action_counters: { U_PALADIN: 2 } };
    const result = step(withCounter, { kind: "wait", actor: "U_PALADIN" }, seqRoll([]));
    expect(result.events.find((e) => e.type === "passive_mage_mana_font")).toBeUndefined();
    expect(result.state.fighters[0].mana).toBe(3); // unchanged
  });
});

describe("mergeEffect — status stacking policy", () => {
  const make = (overrides: Partial<MachineStatusEffect> = {}): MachineStatusEffect => ({
    type: "bleeding",
    magnitude: 2,
    remaining: 3,
    source: "src_a",
    ...overrides,
  });

  it("appends a new type rather than merging", () => {
    const out = mergeEffect([make({ type: "bleeding" })], make({ type: "burning" }));
    expect(out).toHaveLength(2);
    expect(out.map((e) => e.type).sort()).toEqual(["bleeding", "burning"]);
  });

  it("stack-mode (bleed) sums magnitude and keeps the longest remaining", () => {
    const out = mergeEffect(
      [make({ magnitude: 2, remaining: 3 })],
      make({ magnitude: 3, remaining: 5 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].magnitude).toBe(5);
    expect(out[0].remaining).toBe(5);
  });

  it("stack-mode caps magnitude at the per-type ceiling", () => {
    const out = mergeEffect(
      [make({ magnitude: 5 })],
      make({ magnitude: 5 }),
    );
    expect(out[0].magnitude).toBe(6); // bleeding cap is 6
  });

  it("refresh-mode (regen) takes the better magnitude, not the sum", () => {
    const out = mergeEffect(
      [make({ type: "regen", magnitude: 4, remaining: 3 })],
      make({ type: "regen", magnitude: 2, remaining: 5 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].magnitude).toBe(4); // kept the bigger value
    expect(out[0].remaining).toBe(5); // refreshed to longer
  });

  it("refresh-mode (empowered) refreshes duration on re-application", () => {
    const out = mergeEffect(
      [make({ type: "empowered", magnitude: 25, remaining: 1 })],
      make({ type: "empowered", magnitude: 25, remaining: 3 }),
    );
    expect(out).toHaveLength(1);
    expect(out[0].magnitude).toBe(25);
    expect(out[0].remaining).toBe(3);
  });
});
void _unused;
