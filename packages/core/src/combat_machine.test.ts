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
import { posKey } from "./hex";

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

// AC reference (tier 3): monster AC = 7 (6 + floor(3/2)), fighter AC = 10.
// Paladin attack_mod = 2 → needs d20 ≥ 3 to hit. Monster tier 3 → needs ≥ 3.

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
      // d20=15 (+2 = 17 vs AC 7: HIT). d6=4 → damage = (4+2+4) = 10.
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
      expect(check).toMatchObject({ hit: true, total: 17, ac: 7 });
      const hit = result.events.find((e) => e.type === "player_hit");
      expect(hit).toMatchObject({ damage: 10, crit: false });
    });

    it("misses on a low d20, emits hit_check with hit:false, no damage", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      // d20=2 (+2 = 4 vs AC 7: MISS). No damage roll consumed.
      const result = step(
        begun.state,
        { kind: "attack", actor: "U_PALADIN" },
        seqRoll([2]),
      );
      expect(result.state.monsters[0].hp).toBe(40);
      expect(eventTypes(result.events)).toEqual([
        "roll",
        "hit_check",
        "turn_start",
      ]);
      const check = result.events.find((e) => e.type === "hit_check");
      expect(check).toMatchObject({ hit: false, total: 4, ac: 7 });
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
      // Monster tier=3 → modifier = floor(3/2)+6=7. Fighter level=5 → AC=12.
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

  describe("smite ability (QA Paladin)", () => {
    it("spends 1 mana, deals 1d6+atk+wpn+2d8, applies smite debuff", () => {
      const init = baseInit();
      init.fighters[0].mana = 2;
      const begun = runBegin(createCombatState(init), [15, 8]);
      // 1d6=2 + atk_mod 2 + weapon 4 = 8. 2d8 → 3 + 4 = 7. damage = 8 + 7 = 15.
      const result = step(
        begun.state,
        { kind: "ability", actor: "U_PALADIN", ability_id: "smite" },
        seqRoll([2, 3, 4]),
      );
      expect(result.state.fighters[0].mana).toBe(1);
      expect(result.state.monsters[0].hp).toBe(40 - 15);
      const hit = result.events.find((e) => e.type === "player_hit");
      expect(hit).toMatchObject({ damage: 15 });
      const used = result.events.find((e) => e.type === "ability_used");
      expect(used).toMatchObject({ ability_id: "smite", mana_spent: 1 });
      // Smite debuff should be stored in ability_state
      expect(result.state.ability_state?.paladin_smite_debuff?.[MONSTER_ID]).toBe(1);
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
      // Fireball: magic_mod(1) d6. Roll: 4. Damage: 4.
      const result = step(
        begun.state,
        { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
        seqRoll([4]),
      );
      expect(result.state.fighters[0].mana).toBe(1); // 3 - 2 = 1
      const hit = result.events.find((e) => e.type === "player_hit");
      expect(hit).toMatchObject({ damage: 4 });
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
      // magic_mod(1) d6 → roll 3. Damage: 3 each.
      const result = step(
        begun.state,
        { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
        seqRoll([3]),
      );
      expect(result.state.monsters[0].hp).toBe(7); // 10 - 3
      expect(result.state.monsters[1].hp).toBe(7);
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

    describe("LOS gating on AoE", () => {
      // Fireball is "damage all enemies" with no per-target check pre-fix.
      // These tests pin the rule: a focus-weapon caster needs hex line of
      // sight to each individual monster, melee casters bypass (burst), and
      // hex_range_enabled=false (Slack mode) skips the gate entirely.
      function mageHexInit(): CombatInit {
        const init = mageInit({
          hex_range_enabled: true,
          monsters: [
            { name: "Goblin Near", hp: 10, max_hp: 10, tier: 1, is_boss: false },
            { name: "Goblin Far", hp: 10, max_hp: 10, tier: 1, is_boss: false },
          ],
        });
        init.fighters[0].weapon_range = "focus";
        return init;
      }

      it("skips targets the focus-weapon caster can't see", () => {
        const begun = runBegin(createCombatState(mageHexInit()), [15, 10, 5]);
        // Caster at (4,1), monster A at (4,3) — clear LOS; monster B at (4,7)
        // with an obstacle at (4,5) directly between caster and B.
        const setup: CombatState = {
          ...begun.state,
          fighters: begun.state.fighters.map((f) => ({ ...f, pos: { q: 4, r: 1 } })),
          monsters: [
            { ...begun.state.monsters[0], pos: { q: 4, r: 3 } },
            { ...begun.state.monsters[1], pos: { q: 4, r: 7 } },
          ],
          obstacles: [{ pos: { q: 4, r: 5 }, kind: "boulder" }],
        };
        const result = step(
          setup,
          { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
          seqRoll([3]),
        );
        // Near monster takes damage, far monster is untouched.
        expect(result.state.monsters[0].hp).toBe(7);
        expect(result.state.monsters[1].hp).toBe(10);
        const hits = result.events.filter((e) => e.type === "player_hit");
        expect(hits).toHaveLength(1);
      });

      it("rejects when no target has LOS", () => {
        const begun = runBegin(createCombatState(mageHexInit()), [15, 10, 5]);
        // Both monsters behind the same wall, caster looking down a column.
        const setup: CombatState = {
          ...begun.state,
          fighters: begun.state.fighters.map((f) => ({ ...f, pos: { q: 4, r: 1 } })),
          monsters: [
            { ...begun.state.monsters[0], pos: { q: 4, r: 7 } },
            { ...begun.state.monsters[1], pos: { q: 4, r: 9 } },
          ],
          obstacles: [
            { pos: { q: 4, r: 3 }, kind: "boulder" },
            { pos: { q: 4, r: 5 }, kind: "boulder" },
          ],
        };
        const result = step(
          setup,
          { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
          seqRoll([3]),
        );
        const rejected = result.events.find((e) => e.type === "rejected");
        expect(rejected).toBeDefined();
        expect(result.state.monsters[0].hp).toBe(10);
        expect(result.state.monsters[1].hp).toBe(10);
      });

      it("melee-weapon caster bypasses LOS (AoE burst centered on self)", () => {
        const init = mageHexInit();
        init.fighters[0].weapon_range = "melee";
        const begun = runBegin(createCombatState(init), [15, 10, 5]);
        const setup: CombatState = {
          ...begun.state,
          fighters: begun.state.fighters.map((f) => ({ ...f, pos: { q: 4, r: 1 } })),
          monsters: [
            { ...begun.state.monsters[0], pos: { q: 4, r: 7 } },
            { ...begun.state.monsters[1], pos: { q: 4, r: 9 } },
          ],
          obstacles: [{ pos: { q: 4, r: 5 }, kind: "boulder" }],
        };
        const result = step(
          setup,
          { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
          seqRoll([3]),
        );
        // Both monsters damaged despite the wall.
        expect(result.state.monsters[0].hp).toBe(7);
        expect(result.state.monsters[1].hp).toBe(7);
      });

      it("hex_range_enabled=false (Slack mode) bypasses LOS entirely", () => {
        const init = mageHexInit();
        init.hex_range_enabled = false;
        const begun = runBegin(createCombatState(init), [15, 10, 5]);
        const setup: CombatState = {
          ...begun.state,
          obstacles: [{ pos: { q: 4, r: 5 }, kind: "boulder" }],
        };
        const result = step(
          setup,
          { kind: "ability", actor: "U_PALADIN", ability_id: "fireball" },
          seqRoll([3]),
        );
        // No LOS math when hex range is off; both monsters take damage.
        expect(result.state.monsters[0].hp).toBe(7);
        expect(result.state.monsters[1].hp).toBe(7);
      });
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

    it("emits a 'fled' event on success (signals terminal transition to orchestration layer)", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      const result = step(begun.state, { kind: "flee", actor: "U_PALADIN" }, seqRoll([15]));
      expect(result.events.find((e) => e.type === "fled")).toBeDefined();
    });

    it("rejects further actions after a successful flee (fled is terminal)", () => {
      const begun = runBegin(createCombatState(baseInit()), [15, 8]);
      const fled = step(begun.state, { kind: "flee", actor: "U_PALADIN" }, seqRoll([15]));
      expect(fled.state.status).toBe("fled");
      const after = step(fled.state, { kind: "attack", actor: "U_PALADIN" }, seqRoll([15, 4]));
      // State must be unchanged and the action rejected.
      expect(after.state).toBe(fled.state);
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
    // Roll order: d20=15 (hit, 15+2=17 vs mAC=5), d6=4 (no nat-crit),
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
        effects: [{ type: "stunned" as const, magnitude: 30, remaining: 5, source: "U_PALADIN" }],
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
        effects: [{ type: "stunned" as const, magnitude: 30, remaining: 2, source: "U_PALADIN" }],
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

// ── QA Paladin abilities ──────────────────────────────────────────────────────

// Two-fighter party: paladin (back) + a second fighter (front).
// Used by protect damage-split and lay_on_hands double-heal tests.
function twoFighterInit(
  overrides: { paladinHp?: number; paladinMana?: number; fighterHp?: number } = {},
): import("./combat_machine").CombatInit {
  return {
    fighters: [
      {
        ...baseInit().fighters[0],
        hp: overrides.paladinHp ?? 30,
        mana: overrides.paladinMana ?? 3,
        position: "back" as const,
      },
      {
        id: "U_FIGHTER2",
        name: "Corinna",
        class: "Frontend Bard",
        level: 4,
        hp: overrides.fighterHp ?? 20,
        max_hp: 20,
        mana: 2,
        max_mana: 2,
        shield: 0,
        position: "front" as const,
        attack_mod: 0,
        magic_mod: 2,
        weapon_power: 1,
        armor_power: 1,
        scars: [],
      },
    ],
    monster: baseInit().monster!,
  };
}

describe("QA Paladin — shield_of_faith", () => {
  it("spends 2 mana and stores shield_of_faith expiring after round + 2", () => {
    const begun = runBegin(createCombatState(baseInit()), [15, 8]); // paladin first, round=1
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "shield_of_faith" },
      seqRoll([]),
    );
    expect(result.state.fighters[0].mana).toBe(1); // 3 - 2
    expect(result.state.ability_state?.shield_of_faith).toEqual({ expires_after_round: 3 });
    const evt = result.events.find((e) => e.type === "ability_shield_of_faith");
    expect(evt).toMatchObject({ expires_after_round: 3 });
  });

  it("raises fighter AC by 5 so the monster misses a d20 that would otherwise hit", () => {
    // Tier-3 modifier=5, base AC=12. d20=10 → 15 ≥ 12 → hit without SoF,
    // but 15 < 17 → miss with SoF active.
    const begun = runBegin(createCombatState(baseInit()), [15, 8]);
    const afterSof = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "shield_of_faith" },
      seqRoll([]),
    );
    // Monster's turn — d20=10 should miss with SoF.
    const result = step(afterSof.state, { kind: "monster_act" }, seqRoll([50, 10]));
    expect(result.state.fighters[0].hp).toBe(30); // no damage
    const check = result.events.find((e) => e.type === "hit_check");
    expect(check).toMatchObject({ hit: false, total: 15, ac: 17 });
  });

  it("rejects when mana < 2", () => {
    const init = baseInit();
    init.fighters[0].mana = 1;
    const begun = runBegin(createCombatState(init), [15, 8]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "shield_of_faith" },
      seqRoll([]),
    );
    expect(result.events.find((e) => e.type === "rejected")).toBeDefined();
  });
});

describe("QA Paladin — lay_on_hands", () => {
  it("heals target for 1d6 + floor(mag_mod/2) + floor(vit/2) and spends 1 mana", () => {
    // magic_mod=0, no stats field → vit defaults to 5 → floor(5/2)=2.
    // roll(6)=4 → healAmt = 4+0+2 = 6.
    const init = baseInit();
    init.fighters[0].hp = 24;
    init.fighters[0].mana = 2;
    const begun = runBegin(createCombatState(init), [15, 8]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "lay_on_hands" },
      seqRoll([4]),
    );
    expect(result.state.fighters[0].hp).toBe(30); // 24 + 6
    expect(result.state.fighters[0].mana).toBe(1);
    const healEvt = result.events.find((e) => e.type === "heal_applied");
    expect(healEvt).toMatchObject({ amount: 6 });
  });

  it("also heals the caster when the target is the protected ally", () => {
    // paladin at 22 HP, U_FIGHTER2 at 12 HP (max 20), protect links paladin → U_FIGHTER2.
    // roll(6)=3 → healAmt=3+0+2=5; 12+5=17 ≤ 20 so no cap. Both fighters gain 5 HP.
    const begun = runBegin(
      createCombatState(twoFighterInit({ paladinHp: 22, paladinMana: 2, fighterHp: 12 })),
      [15, 8, 6],
    );
    const withProtect = {
      ...begun.state,
      ability_state: { paladin_protect: { paladin_id: "U_PALADIN", target_id: "U_FIGHTER2" } },
    };
    const result = step(
      withProtect,
      { kind: "ability", actor: "U_PALADIN", ability_id: "lay_on_hands", target: "U_FIGHTER2" },
      seqRoll([3]),
    );
    expect(result.state.fighters.find((f) => f.id === "U_FIGHTER2")?.hp).toBe(17); // 12 + 5
    expect(result.state.fighters.find((f) => f.id === "U_PALADIN")?.hp).toBe(27); // 22 + 5
    expect(result.events.filter((e) => e.type === "heal_applied")).toHaveLength(2);
  });
});

describe("QA Paladin — protect", () => {
  it("targeting an ally sets paladin_protect state and emits ability_protect", () => {
    const begun = runBegin(createCombatState(twoFighterInit()), [15, 8, 6]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "protect", target: "U_FIGHTER2" },
      seqRoll([]),
    );
    expect(result.state.ability_state?.paladin_protect).toEqual({
      paladin_id: "U_PALADIN",
      target_id: "U_FIGHTER2",
    });
    expect(result.events.find((e) => e.type === "ability_protect")).toMatchObject({
      actor: "U_PALADIN",
      target: "U_FIGHTER2",
    });
  });

  it("targeting self grants 2d6 + floor(mag_mod/2) + floor(vit/2) shield and sets no protect state", () => {
    // roll(6)=3, roll(6)=4 → 3+4+0+2 = 9 shield.
    const begun = runBegin(createCombatState(baseInit()), [15, 8]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "protect" },
      seqRoll([3, 4]),
    );
    expect(result.state.fighters[0].shield).toBe(9);
    expect(result.state.ability_state?.paladin_protect).toBeUndefined();
    expect(result.events.find((e) => e.type === "shield_applied")).toMatchObject({ restored: 9 });
  });

  it("splits incoming HP damage: protected target takes floor(dmg/2), paladin absorbs the rest", () => {
    // Both fighters are equidistant from the monster in hex mode, so weights are equal (1:1).
    // roll(101)=60 → r = 60/100 * 2 = 1.2; after fighter[0] (Paladin, weight=1): r=0.2 > 0;
    // after fighter[1] (U_FIGHTER2, weight=1): r=-0.8 ≤ 0 → picks U_FIGHTER2.
    // d20=15 → 15+5=20 ≥ AC 12 → HIT.
    // d4=4 → raw=4+3+0=7, hpDamage=7 (no armor pool).
    // U_FIGHTER2 takes floor(7/2)=3; paladin takes 7−3=4.
    const init = twoFighterInit();
    const begun = runBegin(createCombatState(init), [5, 3, 18]); // monster first
    const withProtect = {
      ...begun.state,
      ability_state: { paladin_protect: { paladin_id: "U_PALADIN", target_id: "U_FIGHTER2" } },
    };
    const result = step(withProtect, { kind: "monster_act" }, seqRoll([60, 15, 4]));
    expect(result.state.fighters.find((f) => f.id === "U_FIGHTER2")?.hp).toBe(17); // 20 − 3
    expect(result.state.fighters.find((f) => f.id === "U_PALADIN")?.hp).toBe(26); // 30 − 4
    expect(result.events.find((e) => e.type === "protect_triggered")).toMatchObject({
      paladin: "U_PALADIN",
      target: "U_FIGHTER2",
      target_damage: 3,
      paladin_damage: 4,
    });
  });

  it("rejects when on cooldown", () => {
    const begun = runBegin(createCombatState(baseInit()), [15, 8]);
    const withCooldown = { ...begun.state, cooldowns: { U_PALADIN: { protect: 1 } } };
    const result = step(
      withCooldown,
      { kind: "ability", actor: "U_PALADIN", ability_id: "protect" },
      seqRoll([]),
    );
    expect(result.events.find((e) => e.type === "rejected")).toBeDefined();
  });
});

describe("QA Paladin — holy_rage passive", () => {
  // accumulateHolyRage uses Math.floor, so damage must be ≥ 10 for bonus ≥ 1.
  // Use a boss phase-2 monster (adds tier bonus = 3): d4=4 → raw=4+3+3=10, bonus=1.
  function holyRageInit(): import("./combat_machine").CombatInit {
    const init = baseInit();
    init.monster!.is_boss = true;
    init.monster!.boss_phase = 2;
    return init;
  }

  it("accumulates raw HP damage when the paladin themselves takes damage", () => {
    // d4=4 → raw=4+3(tier)+3(boss)=10, hpDamage=10. Stored as raw 10; bonus=floor(10*0.1)=1.
    const begun = runBegin(createCombatState(holyRageInit()), [5, 18]);
    const result = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 4]));
    expect(result.state.ability_state?.holy_rage?.["U_PALADIN"]).toBe(10);
  });

  it("adds the accumulated bonus to the next attack and then clears it", () => {
    // Monster hits paladin for 10 HP → holy_rage[U_PALADIN]=1.
    // Paladin attacks: d20=15 hit, d6=4 → base=4+2+4=10 + bonus=1 = 11 damage.
    const begun = runBegin(createCombatState(holyRageInit()), [5, 18]);
    const afterMonster = step(begun.state, { kind: "monster_act" }, seqRoll([50, 15, 4]));
    const result = step(
      afterMonster.state,
      { kind: "attack", actor: "U_PALADIN" },
      seqRoll([15, 4]),
    );
    const hit = result.events.find((e) => e.type === "player_hit");
    expect(hit).toMatchObject({ damage: 11 });
    expect(result.events.find((e) => e.type === "passive_holy_rage")).toMatchObject({ bonus: 1 });
    expect(result.state.ability_state?.holy_rage?.["U_PALADIN"]).toBeUndefined();
  });
});

// Rogue fixtures.
// Monster tier 3 → monsterAc = 6 + floor(3/2) = 7.
// Rogue attack_mod = 3 → hit on d20 ≥ 2.
// Rogue level 4 → lethal_strikes stacks = 2 + floor(4/2) = 4.
function rogueInit(rogueOverrides: Partial<CombatInit["fighters"][0]> = {}): CombatInit {
  return {
    fighters: [
      {
        id: "U_ROGUE",
        name: "Kira",
        class: "Refactor Rogue",
        level: 4,
        hp: 25,
        max_hp: 25,
        mana: 4,
        max_mana: 4,
        shield: 0,
        position: "front",
        attack_mod: 3,
        magic_mod: 0,
        weapon_power: 2,
        armor_power: 1,
        scars: [],
        ...rogueOverrides,
      },
    ],
    monster: { name: "Test Monster", hp: 40, max_hp: 40, shield: 0, tier: 3, is_boss: false },
  };
}

describe("Refactor Rogue — Lethal Strikes (passive)", () => {
  it("critting with a normal attack applies bleed equal to 2+floor(lev/2) stacks", () => {
    // Crit = d6 roll of 6. seqRoll: d20=10 (hit), d6=6 (crit).
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const result = step(begun.state, { kind: "attack", actor: "U_ROGUE" }, seqRoll([10, 6]));
    const ls = result.events.find((e) => e.type === "passive_rogue_lethal_strike");
    expect(ls).toBeDefined();
    expect(ls).toMatchObject({ actor: "U_ROGUE", magnitude: 4, duration: 2 });
    expect(result.state.monsters[0].effects.some((e) => e.type === "bleeding" && e.magnitude === 4)).toBe(true);
  });

  it("does not fire on a non-crit attack", () => {
    // d20=8 → total 11 ≥ 5 → hit; not a nat-20 so no crit.
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const result = step(begun.state, { kind: "attack", actor: "U_ROGUE" }, seqRoll([8, 3]));
    expect(result.events.find((e) => e.type === "passive_rogue_lethal_strike")).toBeUndefined();
    expect(result.state.monsters[0].effects.some((e) => e.type === "bleeding")).toBe(false);
  });
});

describe("Refactor Rogue — Vanish", () => {
  it("sets vanished[actorId]=2 and spends 2 mana", () => {
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_ROGUE", ability_id: "vanish" }, seqRoll([]));
    expect(result.state.ability_state?.vanished?.["U_ROGUE"]).toBe(2);
    expect(result.state.fighters[0].mana).toBe(2); // 4 - 2
  });

  it("attacking while vanished forces a crit on hit and removes vanish", () => {
    // d20=10 → 10+3=13 ≥ 5 → hit; d6=4 → raw=4+3+2=9; vanish forces crit → damage doubled.
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const vanishedState: CombatState = {
      ...begun.state,
      ability_state: { vanished: { U_ROGUE: 2 } },
    };
    const result = step(vanishedState, { kind: "attack", actor: "U_ROGUE" }, seqRoll([10, 4]));
    const hitEvt = result.events.find((e) => e.type === "player_hit");
    expect(hitEvt).toMatchObject({ crit: true });
    expect(result.state.ability_state?.vanished?.["U_ROGUE"] ?? 0).toBe(0);
  });
});

describe("Refactor Rogue — Envenom Weapon", () => {
  it("sets envenomed_weapon[actor] with stacks=6 and charges=2, spends 1 mana", () => {
    // level 4 → stacks = 2 + 4 = 6; machine defaults to 2 charges
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_ROGUE", ability_id: "envenom_weapon" }, seqRoll([]));
    expect(result.state.ability_state?.envenomed_weapon?.["U_ROGUE"]).toMatchObject({ stacks: 6, charges: 2 });
    expect(result.state.fighters[0].mana).toBe(3); // 4 - 1
  });

  it("first hit applies poison and decrements charges to 1", () => {
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const envenomed: CombatState = {
      ...begun.state,
      ability_state: { envenomed_weapon: { U_ROGUE: { stacks: 6, charges: 2 } } },
    };
    const result = step(envenomed, { kind: "attack", actor: "U_ROGUE" }, seqRoll([10, 3]));
    expect(result.events.find((e) => e.type === "ability_envenom_proc")).toMatchObject({ actor: "U_ROGUE", stacks: 6 });
    expect(result.state.monsters[0].effects.some((e) => e.type === "poisoned" && e.magnitude === 6)).toBe(true);
    expect(result.state.ability_state?.envenomed_weapon?.["U_ROGUE"]).toMatchObject({ stacks: 6, charges: 1 });
  });

  it("second hit applies poison again and clears envenomed_weapon", () => {
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const envenomed: CombatState = {
      ...begun.state,
      ability_state: { envenomed_weapon: { U_ROGUE: { stacks: 6, charges: 1 } } },
    };
    const result = step(envenomed, { kind: "attack", actor: "U_ROGUE" }, seqRoll([10, 3]));
    expect(result.events.find((e) => e.type === "ability_envenom_proc")).toMatchObject({ actor: "U_ROGUE", stacks: 6 });
    expect(result.state.ability_state?.envenomed_weapon?.["U_ROGUE"]).toBeUndefined();
  });
});

describe("SRE Warden — Bulwark Strike", () => {
  function wardenInit(): CombatInit {
    const init = baseInit();
    init.fighters[0].class = "SRE Warden";
    init.fighters[0].attack_mod = 2;
    init.fighters[0].armor_power = 3;
    init.fighters[0].shield = 2; // Armor Up grants +3 at turn start → shield=5 at execute
    init.fighters[0].mana = 3;
    return init;
  }

  it("on a hit, performs an attack roll and deals 1d10 + attack + 50% current shield", () => {
    // Armor Up fires at turn start: 2 + floor(5/4) = 3 → shield = 2+3 = 5.
    // execute(): d10=5 → shieldBonus=floor(5*0.5)=2; amount = 5 + 2(atk) + 2(sh) = 9.
    // Machine rolls d20=15 → 15+2=17 ≥ 5 (tier 3 AC) → hit; damage=9.
    const begun = runBegin(createCombatState(wardenInit()), [15, 5]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "bulwark_strike", target_id: MONSTER_ID },
      seqRoll([5, 15]),
    );
    expect(result.events.find((e) => e.type === "hit_check")).toMatchObject({ hit: true });
    const hitEvt = result.events.find((e) => e.type === "player_hit");
    expect(hitEvt).toMatchObject({ damage: 9, actor: "U_PALADIN" });
    expect(result.state.monsters[0].hp).toBe(40 - 9);
  });

  it("on a miss, produces no player_hit and advances the turn", () => {
    // execute(): d10=5. Machine rolls d20=1 → 1+2=3 < 9 (tier 3 AC) → miss.
    const begun = runBegin(createCombatState(wardenInit()), [15, 5]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "bulwark_strike", target_id: MONSTER_ID },
      seqRoll([5, 1]),
    );
    expect(result.events.find((e) => e.type === "hit_check")).toMatchObject({ hit: false });
    expect(result.events.find((e) => e.type === "player_hit")).toBeUndefined();
    expect(result.state.monsters[0].hp).toBe(40);
  });

  it("goes on cooldown after use and rejects a second cast", () => {
    const begun = runBegin(createCombatState(wardenInit()), [15, 5]);
    const used = step(
      begun.state,
      { kind: "ability", actor: "U_PALADIN", ability_id: "bulwark_strike", target_id: MONSTER_ID },
      seqRoll([5, 15]),
    );
    expect(used.state.cooldowns?.["U_PALADIN"]?.["bulwark_strike"]).toBeGreaterThan(0);
  });
});

describe("SRE Warden — Taunt (reworked)", () => {
  function wardenFullInit(overrides: Partial<CombatInit> = {}): CombatInit {
    return {
      fighters: [
        {
          id: "U_WARDEN",
          name: "Garrett",
          class: "SRE Warden",
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
          armor_power: 5,
          scars: [],
          stats: { str: 9, int_stat: 4, vit: 10, agi: 4, dex: 3 },
        },
      ],
      monster: baseInit().monster,
      ...overrides,
    };
  }

  // str=9, vit=10 → floor((9+10)/8) = 2 (not doubled, party > 1).
  // Armor Up also fires at turn start: 2 + floor(5/4) = 3. Total shield = 5.
  it("grants floor((vit+str)/8) shield and sets taunt_fortify for 2 turns", () => {
    const twoFighterInit = wardenFullInit({
      fighters: [
        ...wardenFullInit().fighters,
        {
          id: "U_ALLY",
          name: "Ally",
          class: "Frontend Bard",
          level: 1,
          hp: 10,
          max_hp: 10,
          mana: 1,
          max_mana: 1,
          shield: 0,
          position: "back" as const,
          attack_mod: 0,
          magic_mod: 0,
          weapon_power: 1,
          armor_power: 0,
          scars: [],
        },
      ],
    });
    const begun = runBegin(createCombatState(twoFighterInit), [15, 8, 5]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_WARDEN", ability_id: "taunt" },
      seqRoll([1]),
    );
    // Armor Up (3) + Taunt (2) = 5
    expect(result.state.fighters.find((f) => f.id === "U_WARDEN")!.shield).toBe(5);
    expect(result.state.ability_state?.taunt_fortify?.["U_WARDEN"]).toMatchObject({ turns_remaining: 2 });
  });

  it("doubles shield when warden is the only living party member", () => {
    const begun = runBegin(createCombatState(wardenFullInit()), [15, 8]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_WARDEN", ability_id: "taunt" },
      seqRoll([1]),
    );
    // solo party → Taunt doubled = 4; Armor Up = 3. Total = 7.
    expect(result.state.fighters.find((f) => f.id === "U_WARDEN")!.shield).toBe(7);
  });

  it("magic damage depletes shield when taunt_fortify is active", () => {
    // Monster uses lightning so damage would normally bypass shield.
    const init = wardenFullInit({
      monster: { name: "The Lightning Shrieker", hp: 40, max_hp: 40, shield: 0, tier: 3, is_boss: false, attack_damage_type: "lightning" },
    });
    // Monster goes first (warden=8, monster=15).
    const begun = runBegin(createCombatState(init), [8, 15]);
    const withFortify: CombatState = {
      ...begun.state,
      fighters: begun.state.fighters.map((f) => f.id === "U_WARDEN" ? { ...f, shield: 5 } : f),
      ability_state: { taunt_fortify: { U_WARDEN: { turns_remaining: 2 } } },
    };
    // Monster acts: target pick=50, d20=15 (hits AC 12), d4=3 → raw=3+3(tier)=6.
    // With fortify: shield absorbs min(5,6)=5, HP takes 1.
    // 90 = d100 elemental proc check (> 25 threshold → no proc).
    const result = step(withFortify, { kind: "monster_act", actor: MONSTER_ID }, seqRoll([50, 15, 3, 90]));
    const warden = result.state.fighters.find((f) => f.id === "U_WARDEN")!;
    expect(warden.shield).toBe(0);
    expect(warden.hp).toBe(29);
  });

  it("magic damage bypasses shield when taunt_fortify is not active", () => {
    const init = wardenFullInit({
      monster: { name: "The Lightning Shrieker", hp: 40, max_hp: 40, shield: 0, tier: 3, is_boss: false, attack_damage_type: "lightning" },
    });
    const begun = runBegin(createCombatState(init), [8, 15]);
    const withShield: CombatState = {
      ...begun.state,
      fighters: begun.state.fighters.map((f) => f.id === "U_WARDEN" ? { ...f, shield: 5 } : f),
    };
    // No fortify — lightning bypasses shield; all 6 damage goes to HP.
    // 90 = d100 elemental proc check (> 25 threshold → no proc).
    const result = step(withShield, { kind: "monster_act", actor: MONSTER_ID }, seqRoll([50, 15, 3, 90]));
    const warden = result.state.fighters.find((f) => f.id === "U_WARDEN")!;
    expect(warden.shield).toBe(5); // untouched
    expect(warden.hp).toBe(24);    // 30 - 6
  });
});

describe("SRE Warden — Resilient (passive)", () => {
  function wardenFullInit(): CombatInit {
    return {
      fighters: [
        {
          id: "U_WARDEN",
          name: "Garrett",
          class: "SRE Warden",
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
          armor_power: 5,
          scars: [],
          stats: { str: 9, int_stat: 4, vit: 10, agi: 4, dex: 3 },
        },
      ],
      monster: baseInit().monster,
    };
  }

  // tier 3 → AC = 12 (10 + floor(5/2)). Monster modifier = floor(3/2)+4 = 5.
  // For player attacks, there's no d101 target pick — target defaults to first alive monster.
  // Roll order for attack: d20 (hit check), d6 (damage).

  it("successful attack adds a Resilient stack to ability_state", () => {
    const begun = runBegin(createCombatState(wardenFullInit()), [15, 8]);
    // d20=15 (15+2=17 ≥ 12: hit), d6=4
    const result = step(begun.state, { kind: "attack", actor: "U_WARDEN" }, seqRoll([15, 4]));
    const stacks = result.state.ability_state?.resilient?.["U_WARDEN"] ?? [];
    expect(stacks.length).toBe(1);
    // Stack expires at round 1 + 4 = 5.
    expect(stacks[0]).toBe(5);
    expect(result.events.find((e) => e.type === "passive_warden_resilient")).toMatchObject({ actor: "U_WARDEN", stacks: 1 });
  });

  it("attack_roll_damage hit also adds a Resilient stack", () => {
    const begun = runBegin(createCombatState(wardenFullInit()), [15, 8]);
    // bulwark_strike: d10 (execute), then d20 (hit check) in machine.
    // d10=5, d20=15 → 15+2=17 ≥ AC 5 → hit.
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_WARDEN", ability_id: "bulwark_strike" },
      seqRoll([5, 15]),
    );
    const stacks = result.state.ability_state?.resilient?.["U_WARDEN"] ?? [];
    expect(stacks.length).toBe(1);
  });

  it("attack_roll_damage miss does NOT add a Resilient stack", () => {
    const begun = runBegin(createCombatState(wardenFullInit()), [15, 8]);
    // d10=5, d20=1 → 1+2=3 < AC 5 → miss.
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_WARDEN", ability_id: "bulwark_strike" },
      seqRoll([5, 1]),
    );
    expect(result.state.ability_state?.resilient?.["U_WARDEN"]).toBeUndefined();
  });

  it("Resilient stacks raise the shield cap for subsequent shield grants", () => {
    // max_hp=30, base cap=60. With 2 stacks (vit=10 → 4/stack = +8): cap=68.
    // Pre-inject 2 Resilient stacks and shield near the base cap.
    const begun = runBegin(createCombatState(wardenFullInit()), [15, 8]);
    const withStacks: CombatState = {
      ...begun.state,
      fighters: begun.state.fighters.map((f) => f.id === "U_WARDEN" ? { ...f, shield: 58 } : f),
      ability_state: { resilient: { U_WARDEN: [99, 99] } }, // 2 stacks, far future expiry
    };
    // Use grant_shield via brace (grant_shield_from_armor with armor=5, +2 stacks bonus=8, effective=13, 50%=6)
    // Actually use taunt's fx.shield directly — but we can't easily trigger a grant_shield
    // without an ability. Instead, directly verify the cap via Armor Up passive.
    // Armor Up grants 2 + floor(5/4)=3 shield per turn. Cap without Resilient: 60, with 2 stacks: 68.
    // Shield is 58; grant 3 → min(68, 61) = 61. Without stacks it would still be 61 (< base cap 60? no, 61>60).
    // Better: start at shield=59, grant anything → base cap clamps at 60, but Resilient cap allows 68.
    // With shield=62 (above base cap) already set, verify Armor Up still grants (because cap is 68).
    const atHighShield: CombatState = {
      ...begun.state,
      fighters: begun.state.fighters.map((f) => f.id === "U_WARDEN" ? { ...f, shield: 62 } : f),
      ability_state: { resilient: { U_WARDEN: [99, 99] } },
    };
    // Trigger Armor Up by doing warden's turn (wait action fires applyPreActionPassives).
    // But wait action doesn't fire Armor Up... let me use "attack" which calls applyPreActionPassives.
    // Actually: attack calls applyPreActionPassives which calls applyWardenArmorUp.
    // d20=15 (15+2=17 ≥ 12: hit), d6=4 for the attack.
    const result = step(atHighShield, { kind: "attack", actor: "U_WARDEN" }, seqRoll([15, 4]));
    const warden = result.state.fighters.find((f) => f.id === "U_WARDEN")!;
    // Armor Up grants 2 + floor(5/4)=3 shield. cap = 30*2 + 2*(2+floor(10/4)) = 60 + 2*4 = 68.
    // shield = min(68, 62+3) = 65. (Without stacks: min(60, 62+3)=60, clamped to 60.)
    // But wait: the attack itself also adds a Resilient stack. So after Armor Up and the attack:
    // stacks = 3 (2 pre-existing + 1 from the hit), cap = 60 + 3*4 = 72.
    // Pre-attack: Armor Up fires first. At that point stacks=2, cap=68. shield=min(68,65)=65.
    // After attack: stack added (stacks=3), cap=72. Shield stays at 65 (no grant).
    expect(warden.shield).toBe(65);
  });
});

describe("Refactor Rogue — Backstab", () => {
  it("on a hit with advantage, emits player_hit with the pre-rolled max(r1, r2) damage", () => {
    // execute() rolls raw d6s: raw1=4, raw2=3, bestRaw=4, isCrit=false.
    // amount = (4+3+2)*1 = 9. Machine rolls d20 twice: 15,10 → takes 15.
    // 15+3=18 ≥ 7 (monsterAc tier 3) → hit; player_hit.damage=9, crit=false.
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_ROGUE", ability_id: "backstab", target: MONSTER_ID },
      seqRoll([4, 3, 15, 10]),
    );
    expect(result.events.find((e) => e.type === "advantage_used")).toBeDefined();
    const hitEvt = result.events.find((e) => e.type === "player_hit");
    expect(hitEvt).toMatchObject({ damage: 9, actor: "U_ROGUE", crit: false });
  });

  it("on a natural-6 roll, emits player_hit with crit=true and doubled damage", () => {
    // raw1=6 → bestRaw=6, isCrit=true. amount = (6+3+2)*2 = 22.
    // d20: 15,10 → 15; 15+3=18 ≥ 5 → hit.
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_ROGUE", ability_id: "backstab", target: MONSTER_ID },
      seqRoll([6, 3, 15, 10]),
    );
    const hitEvt = result.events.find((e) => e.type === "player_hit");
    expect(hitEvt).toMatchObject({ damage: 22, actor: "U_ROGUE", crit: true });
  });

  it("on a miss, produces no player_hit and advances the turn", () => {
    // execute() rolls r1=4, r2=3 first; machine rolls d20_a=1, d20_b=1 → takes 1 → 1+3=4 < 5 → miss.
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_ROGUE", ability_id: "backstab", target: MONSTER_ID },
      seqRoll([4, 3, 1, 1]),
    );
    expect(result.events.find((e) => e.type === "player_hit")).toBeUndefined();
    expect(result.events.find((e) => e.type === "hit_check")).toMatchObject({ hit: false });
    expect(result.state.monsters[0].hp).toBe(40);
  });
});

describe("Refactor Rogue — Debilitate", () => {
  it("stuns the monster and sets vulnerable with 20% magnitude for 2 rounds", () => {
    // 1-mana, 3-turn cooldown utility ability.
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_ROGUE", ability_id: "debilitate", target: MONSTER_ID },
      seqRoll([]),
    );
    expect(result.state.fighters[0].mana).toBe(3); // 4 - 1
    expect(result.events.find((e) => e.type === "ability_containerize")).toBeDefined();
    expect(result.state.monsters[0].effects.some((e) => e.type === "stunned" && e.magnitude === 100)).toBe(true);
    // round=1, rounds=2 → expires_after_round = 1 + 2 - 1 = 2
    expect(result.state.ability_state?.vulnerable?.[MONSTER_ID]).toMatchObject({
      magnitude: 20,
      expires_after_round: 2,
    });
  });

  it("vulnerable monster takes 20% more damage on next attack", () => {
    // d20=10 → hit; d6=5 → raw=5+3+2=10, vulnMult=1.2 → final=round(10*1.2)=12.
    const begun = runBegin(createCombatState(rogueInit()), [15, 5]);
    const withVuln: CombatState = {
      ...begun.state,
      ability_state: {
        vulnerable: { [MONSTER_ID]: { expires_after_round: 3, magnitude: 20 } },
      },
    };
    const result = step(withVuln, { kind: "attack", actor: "U_ROGUE" }, seqRoll([10, 5]));
    const hitEvt = result.events.find((e) => e.type === "player_hit");
    expect(hitEvt).toMatchObject({ damage: 12 });
  });
});

// ── Mark (free-action communication) ─────────────────────────────────────────

describe("Frontend Bard — Crescendo", () => {
  function bardInit(): CombatInit {
    return {
      fighters: [
        {
          id: "U_BARD",
          name: "Lyric",
          class: "Frontend Bard",
          level: 4,
          hp: 20,
          max_hp: 20,
          mana: 3,
          max_mana: 3,
          shield: 0,
          position: "front",
          attack_mod: 0,
          magic_mod: 2,
          weapon_power: 2,
          armor_power: 0,
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
    };
  }

  // tier 3 → AC = 5 (4 + floor(3/2)). magic_mod = 2 → need d20 ≥ 3 to hit.
  // Roll order for the ability action: d6 (damage in execute), d20 (hit check).

  it("hit: spends 1 mana and deals 1d6 + magic + party×2 + weapon on a successful roll", () => {
    const begun = runBegin(createCombatState(bardInit()), [15, 8]);
    // d6=3, d20=15 → 15+2=17 ≥ AC 5 → hits. amount = 3+2+2+2 = 9.
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_BARD", ability_id: "crescendo" },
      seqRoll([3, 15]),
    );
    expect(result.state.fighters[0].mana).toBe(2);
    expect(result.state.monsters[0].hp).toBe(31);
    const hit = result.events.find((e) => e.type === "player_hit");
    expect(hit).toMatchObject({ damage: 9 });
  });

  it("miss: no damage when d20 + magic fails to reach AC", () => {
    const begun = runBegin(createCombatState(bardInit()), [15, 8]);
    // d6=3, d20=1 → 1+2=3 < AC 5 → miss. Monster hp unchanged.
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_BARD", ability_id: "crescendo" },
      seqRoll([3, 1]),
    );
    expect(result.state.monsters[0].hp).toBe(40);
    expect(result.events.find((e) => e.type === "player_hit")).toBeUndefined();
  });
});

describe("Frontend Bard — Serenade", () => {
  it("heals and shields the explicitly chosen ally", () => {
    const init: CombatInit = {
      fighters: [
        {
          id: "U_BARD",
          name: "Lyric",
          class: "Frontend Bard",
          level: 4,
          hp: 20,
          max_hp: 20,
          mana: 3,
          max_mana: 3,
          shield: 0,
          position: "back",
          attack_mod: 0,
          magic_mod: 2,
          weapon_power: 0,
          armor_power: 0,
          scars: [],
        },
        {
          id: "U_PALADIN",
          name: "Edmund",
          class: "QA Paladin",
          level: 5,
          hp: 10,
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
      monster: baseInit().monster,
    };
    // initiative: bard=15, paladin=10, monster=8 → bard goes first.
    const begun = runBegin(createCombatState(init), [15, 10, 8]);
    // Roll order in execute: d6=4, d6=3. heal = 4+3+2(magic)=9. shield = 2+floor(4/5)=2.
    const result = step(
      begun.state,
      { kind: "ability", actor: "U_BARD", ability_id: "serenade", target: "U_PALADIN" },
      seqRoll([4, 3]),
    );
    const paladin = result.state.fighters.find((f) => f.id === "U_PALADIN")!;
    expect(paladin.hp).toBe(19);    // 10 + 9
    expect(paladin.shield).toBe(2);
    expect(result.state.fighters.find((f) => f.id === "U_BARD")!.mana).toBe(2); // mana_cost=1
  });
});

describe("mark", () => {
  // Two-fighter party so we can mark out-of-turn.
  function markInit(): import("./combat_machine").CombatInit {
    return {
      fighters: [
        {
          id: "U_A",
          name: "Alice",
          class: "QA Paladin",
          level: 5,
          hp: 30,
          max_hp: 30,
          mana: 3,
          max_mana: 3,
          shield: 0,
          position: "front" as const,
          attack_mod: 2,
          magic_mod: 0,
          weapon_power: 4,
          armor_power: 3,
          scars: [],
        },
        {
          id: "U_B",
          name: "Bob",
          class: "Frontend Bard",
          level: 4,
          hp: 20,
          max_hp: 20,
          mana: 2,
          max_mana: 2,
          shield: 0,
          position: "back" as const,
          attack_mod: 0,
          magic_mod: 2,
          weapon_power: 2,
          armor_power: 1,
          scars: [],
        },
      ],
      monster: baseInit().monster!,
    };
  }

  it("applies mark state with correct marked_by and expiry", () => {
    // Alice goes first (higher initiative roll).
    const begun = runBegin(createCombatState(markInit()), [20, 5, 1]);
    const result = step(begun.state, { kind: "mark", actor: "U_A" }, seqRoll([]));
    expect(result.state.ability_state?.mark).toMatchObject({
      marked_by: "U_A",
      expires_after_round: begun.state.round + 2,
    });
  });

  it("does not consume the actor's turn", () => {
    const begun = runBegin(createCombatState(markInit()), [20, 5, 1]);
    const before = begun.state.turn_index;
    const result = step(begun.state, { kind: "mark", actor: "U_A" }, seqRoll([]));
    expect(result.state.turn_index).toBe(before);
  });

  it("can be applied by a fighter who is not the current actor (free action)", () => {
    // Alice wins initiative and goes first.
    const begun = runBegin(createCombatState(markInit()), [20, 5, 1]);
    const currentActorId = begun.state.turn_order[begun.state.turn_index % begun.state.turn_order.length];
    expect(currentActorId).toBe("U_A"); // sanity: Alice is up

    // Bob marks even though it's Alice's turn.
    const result = step(begun.state, { kind: "mark", actor: "U_B" }, seqRoll([]));
    expect(result.state.ability_state?.mark?.marked_by).toBe("U_B");
    // Alice's turn is still active.
    const actorAfter = result.state.turn_order[result.state.turn_index % result.state.turn_order.length];
    expect(actorAfter).toBe("U_A");
  });

  it("emits mark_applied event with no bonus", () => {
    const begun = runBegin(createCombatState(markInit()), [20, 5, 1]);
    const result = step(begun.state, { kind: "mark", actor: "U_A" }, seqRoll([]));
    const evt = result.events.find((e) => e.type === "mark_applied");
    expect(evt).toBeDefined();
    expect(evt).not.toHaveProperty("bonus");
  });

  it("re-marking resets the expiry round", () => {
    const begun = runBegin(createCombatState(markInit()), [20, 5, 1]);
    const first = step(begun.state, { kind: "mark", actor: "U_A" }, seqRoll([]));
    // Bump round manually then re-mark.
    const laterState: CombatState = { ...first.state, round: first.state.round + 1 };
    const second = step(laterState, { kind: "mark", actor: "U_B" }, seqRoll([]));
    expect(second.state.ability_state?.mark?.expires_after_round).toBe(laterState.round + 2);
    expect(second.state.ability_state?.mark?.marked_by).toBe("U_B");
  });

  it("attack damage is not affected by an active mark", () => {
    // Alice (U_A) marks, then Bob (U_B, the Frontend Bard) attacks — no mark bonus.
    // d20=10 → hit (attack_mod 0, tier 3 AC=5 → need ≥ 5), d6=2 → dmg = 2+0+2(wp)+1(bard aura)=5.
    // If the old mark bonus (+2) were still applied this would be 7.
    const begun = runBegin(createCombatState(markInit()), [20, 5, 1]);
    const marked: CombatState = {
      ...begun.state,
      ability_state: { mark: { marked_by: "U_A", expires_after_round: 99, monster_id: MONSTER_ID } },
      // Force Bob to front row so melee attack isn't blocked.
      fighters: begun.state.fighters.map((f) => f.id === "U_B" ? { ...f, position: "front" as const } : f),
      // Force it to be Bob's turn.
      turn_order: ["U_B", MONSTER_ID, "U_A"],
      turn_index: 0,
    };
    const result = step(marked, { kind: "attack", actor: "U_B" }, seqRoll([10, 2]));
    const hitEvt = result.events.find((e) => e.type === "player_hit");
    expect(hitEvt).toMatchObject({ damage: 5 }); // +1 bard self-aura (level 4 → floor(4/5)=0, base=1)
  });
});

describe("focus weapon — magic_mod to hit, reduced weapon_power", () => {
  // tier 3 → AC = 5 (4 + floor(3/2)). magic_mod=3 → need d20 ≥ 2 to hit.
  // weapon_power=4 represents floor(item_power/4) pre-computed at combat init.
  function focusInit(): CombatInit {
    return {
      fighters: [
        {
          id: "U_MAGE",
          name: "Ariel",
          class: "DevOps Mage",
          level: 3,
          hp: 20,
          max_hp: 20,
          mana: 3,
          max_mana: 3,
          shield: 0,
          position: "front",
          attack_mod: 0,
          magic_mod: 3,
          weapon_power: 4,
          weapon_range: "focus",
          armor_power: 0,
          scars: [],
        },
      ],
      monster: {
        name: "Test Monster",
        hp: 40,
        max_hp: 40,
        shield: 0,
        tier: 3,
        is_boss: false,
      },
    };
  }

  it("uses magic_mod (not attack_mod) for the to-hit modifier", () => {
    const begun = runBegin(createCombatState(focusInit()), [15, 8]);
    // d20=4 + magic_mod(3) = 7 ≥ AC 7 → HIT. attack_mod=0 would miss (4+0=4 < 7).
    const result = step(begun.state, { kind: "attack", actor: "U_MAGE" }, seqRoll([4, 3]));
    const check = result.events.find((e) => e.type === "hit_check");
    expect(check).toMatchObject({ hit: true, total: 7, modifier: 3 });
  });

  it("misses when d20 + magic_mod falls below AC", () => {
    const begun = runBegin(createCombatState(focusInit()), [15, 8]);
    // d20=1 + magic_mod(3) = 4 < AC 7 → MISS.
    const result = step(begun.state, { kind: "attack", actor: "U_MAGE" }, seqRoll([1, 3]));
    const check = result.events.find((e) => e.type === "hit_check");
    expect(check).toMatchObject({ hit: false, total: 4, modifier: 3 });
  });

  it("applies weapon_power (item_power/4) to damage on hit", () => {
    const begun = runBegin(createCombatState(focusInit()), [15, 8]);
    // d20=15 hit. d6=4. damage = 4 + attack_mod(0) + weapon_power(4) = 8. magic_mod not added to damage.
    const result = step(begun.state, { kind: "attack", actor: "U_MAGE" }, seqRoll([15, 4]));
    const hit = result.events.find((e) => e.type === "player_hit");
    expect(hit).toMatchObject({ damage: 8 });
    expect(result.state.monsters[0].hp).toBe(32);
  });
});

// ─── Staff Sage ─────────────────────────────────────────────────────────────
//
// Sage AC = fighterAc(4) = 10 + floor(4/2) = 12.
// Monster modifier = floor(tier(3)/2) + 4 = 5. d20 ≥ 7 hits, ≤ 6 misses.
// Tier 3 damage: d4 + tier(3) + partyBonus(0, solo) = d4+3.
// Ray of Frost: monsterAc(3) = 9; hit_mod = magic_mod = 2 → d20 ≥ 7 hits.
// monster_act seqRoll (sage next, first swing, hits, d4=3): [d101=50 (target pick), d20=10, d4=3, d101=50 (foresee pre-roll)].
// Subsequent monster_acts after foresee fires skip the leading d101 (foretold_target already stored in state).

function sageInit(): CombatInit {
  return {
    fighters: [
      {
        id: "U_SAGE",
        name: "Aria",
        class: "Staff Sage",
        level: 4,
        hp: 20,
        max_hp: 20,
        mana: 4,
        max_mana: 4,
        shield: 0,
        position: "front",
        attack_mod: 0,
        magic_mod: 2,
        weapon_power: 0,
        armor_power: 0,
        scars: [],
      },
    ],
    monster: { name: "Test Monster", hp: 40, max_hp: 40, shield: 0, tier: 3, is_boss: false },
  };
}

describe("Staff Sage — Foretell (passive)", () => {
  it("emits ability_foresee after monster_act when Sage is next actor", () => {
    // Sage wins initiative, waits. Monster acts and swings (d20=10 hit, d4=3 dmg).
    // Foretell fires via withForeseeForNextActor; consumes roll(101) for target pick.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const waited = step(begun.state, { kind: "wait", actor: "U_SAGE" }, seqRoll([]));
    const result = step(waited.state, { kind: "monster_act" }, seqRoll([50, 10, 3, 50]));
    const foresee = result.events.find((e) => e.type === "ability_foresee");
    expect(foresee).toBeDefined();
    expect(foresee).toMatchObject({ actor: "U_SAGE", turns_remaining: 99 });
  });

  it("does not cost mana", () => {
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const waited = step(begun.state, { kind: "wait", actor: "U_SAGE" }, seqRoll([]));
    const result = step(waited.state, { kind: "monster_act" }, seqRoll([50, 10, 3, 50]));
    expect(result.state.fighters[0].mana).toBe(4);
  });

  it("emits ability_foresee at begin when monster wins initiative (acts before sage)", () => {
    // Monster wins initiative (20 > 5), so it acts first. Foresee should fire
    // during begin so the Sage has a prediction before the first swing.
    // begin seqRoll: d20=5 (sage), d20=20 (monster), d101=50 (foresee pre-roll).
    const begun = runBegin(createCombatState(sageInit()), [5, 20, 50]);
    const foresee = begun.events.find((e) => e.type === "ability_foresee");
    expect(foresee).toBeDefined();
    expect(foresee).toMatchObject({ actor: "U_SAGE", predicted_target: "U_SAGE" });
    expect(begun.state.ability_state?.foretold_targets?.[MONSTER_ID]).toBe("U_SAGE");
  });

  it("does not emit foresee at begin when sage wins initiative", () => {
    // Sage wins (20 > 5); no begin-time foresee needed since sage acts first
    // and will get foresee normally after the monster swings.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    expect(begun.events.find((e) => e.type === "ability_foresee")).toBeUndefined();
  });

  it("predicted_target matches actual attack target (deterministic)", () => {
    // Monster wins initiative; foresee pre-rolls target=U_SAGE at begin.
    // Monster then attacks; should hit U_SAGE (no d101 needed for target pick).
    const begun = runBegin(createCombatState(sageInit()), [5, 20, 50]);
    const monsterStep = step(begun.state, { kind: "monster_act" }, seqRoll([10, 3, 50]));
    const attack = monsterStep.events.find((e) => e.type === "monster_attack");
    expect(attack).toMatchObject({ target: "U_SAGE" });
  });

  it("pre-rolls targets for all monsters in a multi-monster round", () => {
    // Two monsters both act before sage. Begin pre-rolls a target for each.
    const twoMonsterSageInit: CombatInit = {
      fighters: sageInit().fighters,
      monsters: [
        { name: "Mob A", hp: 10, max_hp: 10, tier: 1, is_boss: false },
        { name: "Mob B", hp: 10, max_hp: 10, tier: 1, is_boss: false },
      ],
    };
    // begin: sage=1 (loses to both), mob A=10, mob B=8; d101=50×2 for foresee pre-rolls.
    const begun = runBegin(createCombatState(twoMonsterSageInit), [1, 10, 8, 50, 50]);
    expect(begun.state.ability_state?.foretold_targets?.["__monster_0__"]).toBeDefined();
    expect(begun.state.ability_state?.foretold_targets?.["__monster_1__"]).toBeDefined();
    // Mob A acts: uses its foretold target (no d101 for target pick).
    // seqRoll: d20=10 hit, d4=1 damage (Mob B is still next, no foresee fires here).
    const m0Step = step(begun.state, { kind: "monster_act" }, seqRoll([10, 1]));
    // Mob A's entry is consumed; Mob B's remains for its upcoming turn.
    expect(m0Step.state.ability_state?.foretold_targets?.["__monster_0__"]).toBeUndefined();
    expect(m0Step.state.ability_state?.foretold_targets?.["__monster_1__"]).toBeDefined();
    // Mob B acts: uses its foretold target (no d101). Sage is next so foresee fires,
    // pre-rolling fresh targets for round 2 (two more d101 values consumed).
    const m1Step = step(m0Step.state, { kind: "monster_act" }, seqRoll([10, 1, 50, 50]));
    // Foresee re-populated foretold_targets for the next round.
    expect(m1Step.state.ability_state?.foretold_targets?.["__monster_0__"]).toBeDefined();
    expect(m1Step.state.ability_state?.foretold_targets?.["__monster_1__"]).toBeDefined();
  });
});

describe("Staff Sage — Ray of Frost", () => {
  it("spends 1 mana and deals magic_mod×d4 damage on hit", () => {
    // execute(): d4=3, d4=2 → amount = 5; d20=10 → 10+2=12 ≥ 9 hit; d100=50 no freeze.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "ray_of_frost", target_id: MONSTER_ID }, seqRoll([3, 2, 10, 50]));
    const hitEvt = result.events.find((e) => e.type === "player_hit");
    expect(hitEvt).toMatchObject({ actor: "U_SAGE", target: MONSTER_ID, damage: 5 });
    expect(result.state.fighters[0].mana).toBe(3); // 4 - 1
    expect(result.state.monsters[0].hp).toBe(35); // 40 - 5
  });

  it("emits no player_hit on a miss", () => {
    // d20=2 → 2+2=4 < 7 miss. No damage die or freeze roll consumed.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "ray_of_frost", target_id: MONSTER_ID }, seqRoll([3, 2, 2]));
    expect(result.events.find((e) => e.type === "player_hit")).toBeUndefined();
    expect(result.state.monsters[0].hp).toBe(40);
  });

  it("applies frozen when freeze roll ≤ 25", () => {
    // d4=3, d4=2, d20=10 hit, d100=25 ≤ 25 → freeze.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "ray_of_frost", target_id: MONSTER_ID }, seqRoll([3, 2, 10, 25]));
    expect(result.state.monsters[0].effects.some((e) => e.type === "frozen")).toBe(true);
    expect(result.events.find((e) => e.type === "ability_freeze_applied")).toMatchObject({ actor: "U_SAGE", target: MONSTER_ID });
  });

  it("does not apply frozen when freeze roll > 25", () => {
    // d100=26 > 25 → no freeze.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "ray_of_frost", target_id: MONSTER_ID }, seqRoll([3, 2, 10, 26]));
    expect(result.state.monsters[0].effects.some((e) => e.type === "frozen")).toBe(false);
    expect(result.events.find((e) => e.type === "ability_freeze_applied")).toBeUndefined();
  });

  it("does not apply frozen on a miss", () => {
    // d20=2 miss → no freeze roll consumed.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "ray_of_frost", target_id: MONSTER_ID }, seqRoll([3, 2, 2]));
    expect(result.state.monsters[0].effects.some((e) => e.type === "frozen")).toBe(false);
  });
});

describe("Staff Sage — Blizzard", () => {
  it("spends 2 mana, stores charges=3, fires first tick immediately (charges → 2)", () => {
    // execute() rolls nothing; applyBlizzardTick fires on cast: d6=3 → 3+mag(2)=5. d100=50 no freeze.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "blizzard" }, seqRoll([3, 50]));
    expect(result.state.fighters[0].mana).toBe(2); // 4 - 2
    expect(result.state.ability_state?.blizzard?.charges).toBe(2);
    expect(result.state.monsters[0].hp).toBe(35); // 40 - 5
    const tickEvt = result.events.find((e) => e.type === "ability_blizzard_tick");
    expect(tickEvt).toMatchObject({ actor: "U_SAGE", charges_remaining: 2, hits: [{ target: MONSTER_ID, damage: 5 }] });
  });

  it("fires a tick on each subsequent sage action and clears after 3 total ticks", () => {
    // cast (tick 1 → charges 2), monster acts, wait (tick 2 → charges 1), monster acts, wait (tick 3 → clears).
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const s1 = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "blizzard" }, seqRoll([3, 50]));
    expect(s1.state.ability_state?.blizzard?.charges).toBe(2);

    const s2 = step(s1.state, { kind: "monster_act" }, seqRoll([50, 10, 3, 50]));
    const s3 = step(s2.state, { kind: "wait", actor: "U_SAGE" }, seqRoll([4, 50]));
    expect(s3.state.ability_state?.blizzard?.charges).toBe(1);

    // foretold_target was stored by s2's foresee, so no d101 needed for target pick here.
    const s4 = step(s3.state, { kind: "monster_act" }, seqRoll([10, 3, 50]));
    const s5 = step(s4.state, { kind: "wait", actor: "U_SAGE" }, seqRoll([2, 50]));
    expect(s5.state.ability_state?.blizzard).toBeUndefined();
  });

  it("tick damages all alive monsters", () => {
    const init: CombatInit = {
      fighters: sageInit().fighters,
      monsters: [
        { name: "Mob A", hp: 20, max_hp: 20, tier: 1, is_boss: false },
        { name: "Mob B", hp: 20, max_hp: 20, tier: 1, is_boss: false },
      ],
    };
    // Sage wins; cast blizzard. Tick hits both mobs: [d6=2,d100=50, d6=1,d100=50]
    // Mob A: 2+2=4; Mob B: 1+2=3.
    const begun = runBegin(createCombatState(init), [20, 5, 1]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "blizzard" }, seqRoll([2, 50, 1, 50]));
    expect(result.state.monsters[0].hp).toBe(16); // 20 - 4
    expect(result.state.monsters[1].hp).toBe(17); // 20 - 3
  });

  it("applies frozen to a surviving monster when freeze roll ≤ 10", () => {
    // d6=1, d100=5 ≤ 10 → frozen effect applied (blizzard tick does not emit ability_freeze_applied).
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "blizzard" }, seqRoll([1, 5]));
    expect(result.state.monsters[0].effects.some((e) => e.type === "frozen")).toBe(true);
  });

  it("does not apply frozen when freeze roll > 10", () => {
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "blizzard" }, seqRoll([1, 11]));
    expect(result.state.monsters[0].effects.some((e) => e.type === "frozen")).toBe(false);
  });
});

describe("Staff Sage — Good Fortune", () => {
  it("spends 1 mana, heals immediately, and stores delayed amount = 2× immediate", () => {
    // Sage at 5 HP. d4=3 → amount = 3 + mag(2) = 5; delayed = 10.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const wounded: CombatState = {
      ...begun.state,
      fighters: begun.state.fighters.map((f) => f.id === "U_SAGE" ? { ...f, hp: 5 } : f),
    };
    const result = step(wounded, { kind: "ability", actor: "U_SAGE", ability_id: "good_fortune", target: "U_SAGE" }, seqRoll([3]));
    expect(result.state.fighters[0].hp).toBe(10); // 5 + 5
    expect(result.state.fighters[0].mana).toBe(3); // 4 - 1
    expect(result.state.cooldowns?.["U_SAGE"]?.["good_fortune"]).toBe(2); // cooldown_turns(1) + 1
    expect(result.events.find((e) => e.type === "heal_applied")).toMatchObject({ actor: "U_SAGE", target: "U_SAGE", amount: 5 });
    expect(result.state.ability_state?.good_fortune).toMatchObject({ caster_id: "U_SAGE", target_id: "U_SAGE", amount: 10 });
  });

  it("delayed heal fires at the start of the caster's next action", () => {
    // Sage at 5 HP → immediate +5 → hp=10. Monster hits for 6 → hp=4. Delayed +10 → hp=14.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const wounded: CombatState = {
      ...begun.state,
      fighters: begun.state.fighters.map((f) => f.id === "U_SAGE" ? { ...f, hp: 5 } : f),
    };
    const cast = step(wounded, { kind: "ability", actor: "U_SAGE", ability_id: "good_fortune", target: "U_SAGE" }, seqRoll([3]));
    const monsterStep = step(cast.state, { kind: "monster_act" }, seqRoll([50, 10, 3, 50]));
    // Sage hp after monster swing: 10 - (3+3) = 4
    const waitStep = step(monsterStep.state, { kind: "wait", actor: "U_SAGE" }, seqRoll([]));
    expect(waitStep.state.fighters[0].hp).toBe(14); // 4 + 10
    expect(waitStep.events.find((e) => e.type === "ability_good_fortune_delayed")).toMatchObject({ actor: "U_SAGE", target: "U_SAGE", amount: 10 });
    expect(waitStep.state.ability_state?.good_fortune).toBeUndefined();
  });
});

describe("Staff Sage — Ill Omen", () => {
  it("spends 1 mana, goes on 1-turn cooldown, sets ill_omen with monster_turns_remaining=3", () => {
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const result = step(begun.state, { kind: "ability", actor: "U_SAGE", ability_id: "ill_omen", target_id: MONSTER_ID }, seqRoll([]));
    expect(result.state.fighters[0].mana).toBe(3); // 4 - 1
    expect(result.state.cooldowns?.["U_SAGE"]?.["ill_omen"]).toBe(2);
    expect(result.state.ability_state?.ill_omen?.[MONSTER_ID]).toMatchObject({
      caster_id: "U_SAGE",
      accumulated: 0,
      monster_turns_remaining: 3,
    });
    expect(result.events.find((e) => e.type === "ability_ill_omen_applied")).toMatchObject({ actor: "U_SAGE", target: MONSTER_ID });
  });

  it("accumulates ability damage dealt to the marked monster", () => {
    // Inject ill_omen state; cast Ray of Frost: d4=3, d4=2 → 5 dmg, d20=10 hit, d100=50 no freeze.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const withOmen: CombatState = {
      ...begun.state,
      ability_state: { ill_omen: { [MONSTER_ID]: { caster_id: "U_SAGE", accumulated: 0, monster_turns_remaining: 3 } } },
    };
    const result = step(withOmen, { kind: "ability", actor: "U_SAGE", ability_id: "ray_of_frost", target_id: MONSTER_ID }, seqRoll([3, 2, 10, 50]));
    expect(result.state.ability_state?.ill_omen?.[MONSTER_ID]?.accumulated).toBe(5);
  });

  it("decrements monster_turns_remaining on each monster act without bursting early", () => {
    // Inject with monster acting first: 3 → 2 → 1 over two monster acts.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const withOmen3: CombatState = {
      ...begun.state,
      ability_state: { ill_omen: { [MONSTER_ID]: { caster_id: "U_SAGE", accumulated: 10, monster_turns_remaining: 3 } } },
      turn_order: [MONSTER_ID, "U_SAGE"],
      turn_index: 0,
    };
    // monster_act 1: 3 → 2. seqRoll: [d101, d20, d4, d101(foresee)]
    const m1 = step(withOmen3, { kind: "monster_act" }, seqRoll([50, 10, 3, 50]));
    expect(m1.state.ability_state?.ill_omen?.[MONSTER_ID]?.monster_turns_remaining).toBe(2);
    expect(m1.events.find((e) => e.type === "ability_ill_omen_burst")).toBeUndefined();

    const afterM1: CombatState = { ...m1.state, turn_order: [MONSTER_ID, "U_SAGE"], turn_index: 0 };
    // monster_act 2: 2 → 1. foretold_target was stored by m1's foresee, so no d101 for target pick.
    const m2 = step(afterM1, { kind: "monster_act" }, seqRoll([10, 3, 50]));
    expect(m2.state.ability_state?.ill_omen?.[MONSTER_ID]?.monster_turns_remaining).toBe(1);
    expect(m2.events.find((e) => e.type === "ability_ill_omen_burst")).toBeUndefined();
  });

  it("burst fires on 3rd monster turn for 50% of accumulated damage", () => {
    // Inject with monster_turns_remaining=1 and accumulated=20. Burst = floor(20*0.5) = 10.
    // Monster survives (40-10=30); monster still swings, then Foretell fires.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const readyToBurst: CombatState = {
      ...begun.state,
      ability_state: { ill_omen: { [MONSTER_ID]: { caster_id: "U_SAGE", accumulated: 20, monster_turns_remaining: 1 } } },
      turn_order: [MONSTER_ID, "U_SAGE"],
      turn_index: 0,
    };
    // seqRoll: [d101=50, d20=10 hit, d4=3, d101=50 foresee]
    const result = step(readyToBurst, { kind: "monster_act" }, seqRoll([50, 10, 3, 50]));
    const burstEvt = result.events.find((e) => e.type === "ability_ill_omen_burst");
    expect(burstEvt).toMatchObject({ actor: "U_SAGE", target: MONSTER_ID, accumulated: 20, burst: 10 });
    // Monster hp: 40 - 10 (burst) = 30. The swing hits the Sage (not the monster).
    expect(result.state.monsters[0].hp).toBe(30);
    expect(result.state.ability_state?.ill_omen).toBeUndefined();
  });

  it("burst kill resolves victory without monster swinging", () => {
    // Monster at 10 HP; accumulated=30 → burst=15 > 10 → kill. No swing, no foresee.
    const begun = runBegin(createCombatState(sageInit()), [20, 5]);
    const readyToBurst: CombatState = {
      ...begun.state,
      monsters: begun.state.monsters.map((m) => m.id === MONSTER_ID ? { ...m, hp: 10 } : m),
      ability_state: { ill_omen: { [MONSTER_ID]: { caster_id: "U_SAGE", accumulated: 30, monster_turns_remaining: 1 } } },
      turn_order: [MONSTER_ID, "U_SAGE"],
      turn_index: 0,
    };
    const result = step(readyToBurst, { kind: "monster_act" }, seqRoll([]));
    expect(result.state.status).toBe("victory");
    expect(result.events.find((e) => e.type === "ability_ill_omen_burst")).toMatchObject({ accumulated: 30, burst: 15 });
    expect(result.events.find((e) => e.type === "victory")).toBeDefined();
  });
});

describe("hex obstacles", () => {
  // Ranged fighter at (1,3), monster at (11,3), obstacle planted between them.
  // Verifies the obstacle blocks LOS and the engine emits a reject.
  function rangedInit(): CombatInit {
    return {
      fighters: [{
        id: "U_RANGER",
        name: "Aria",
        class: "Refactor Rogue",
        level: 5,
        hp: 20, max_hp: 20, mana: 3, max_mana: 3, shield: 0,
        position: "front",
        attack_mod: 2, magic_mod: 0,
        weapon_power: 4, focus_power: 0,
        weapon_range: "ranged",
        armor_power: 0,
        scars: [],
      }],
      monster: {
        name: "Bandit",
        hp: 20, max_hp: 20, tier: 1,
        is_boss: false,
      },
      hex_range_enabled: true,
    };
  }

  function runBegin(state: CombatState, initRolls: number[]) {
    return step(state, { kind: "begin" }, seqRoll(initRolls));
  }

  it("generateObstacles is wired into createCombatState via scene_seed", () => {
    const init = { ...rangedInit(), scene_seed: 42, scene: "cave" };
    const state = createCombatState(init);
    expect(state.obstacles?.length).toBeGreaterThanOrEqual(2);
    expect(state.obstacles?.length).toBeLessThanOrEqual(4);
    expect(state.scene).toBe("cave");
  });

  it("scene_seed undefined → no obstacles generated", () => {
    const state = createCombatState(rangedInit());
    expect(state.obstacles).toEqual([]);
  });

  it("obstacle on the ray between attacker and target blocks LOS", () => {
    // Position actors 4 hexes apart (within ranged 5-hex range), obstacle at midpoint (3,3).
    const init = rangedInit();
    const begun = runBegin(createCombatState(init), [20, 5]);
    const withObstacle: CombatState = {
      ...begun.state,
      fighters: begun.state.fighters.map((f) => ({ ...f, pos: { q: 1, r: 3 } })),
      monsters: begun.state.monsters.map((m) => ({ ...m, pos: { q: 5, r: 3 } })),
      obstacles: [{ pos: { q: 3, r: 3 }, kind: "boulder" }],
    };
    const result = step(withObstacle, { kind: "attack", actor: "U_RANGER" }, seqRoll([20, 6]));
    // The engine rejects the attack with a "rejected" event citing no line of sight.
    const rejected = result.events.find((e) => e.type === "rejected");
    expect(rejected).toMatchObject({ reason: "no line of sight to target" });
    expect(result.state.monsters[0].hp).toBe(20);
  });

  it("obstacle off the ray does not block LOS — attack proceeds", () => {
    const init = rangedInit();
    const begun = runBegin(createCombatState(init), [20, 5]);
    const withObstacle: CombatState = {
      ...begun.state,
      fighters: begun.state.fighters.map((f) => ({ ...f, pos: { q: 1, r: 3 } })),
      monsters: begun.state.monsters.map((m) => ({ ...m, pos: { q: 5, r: 3 } })),
      // Off the line between (1,3) and (5,3) — placed two rows below.
      obstacles: [{ pos: { q: 3, r: 6 }, kind: "boulder" }],
    };
    const result = step(withObstacle, { kind: "attack", actor: "U_RANGER" }, seqRoll([20, 6]));
    // Attack lands: monster takes damage.
    expect(result.state.monsters[0].hp).toBeLessThan(20);
  });

  it("obstacle hexes are excluded from monster auto-move pathing", () => {
    // Vertical brick layout: fighter near the top, monster near the bottom,
    // obstacle wall blocking the direct path. Verify monster still moves
    // (around the obstacles) rather than getting stuck on its starting hex.
    const init = rangedInit();
    init.monster!.tier = 3; // ensure move_range >= 3 so it can route around
    const begun = runBegin(createCombatState({ ...init, scene_seed: 1 }), [5, 20]);
    const monsterStart = { q: 3, r: 9 };
    const withSetup: CombatState = {
      ...begun.state,
      fighters: begun.state.fighters.map((f) => ({ ...f, pos: { q: 4, r: 5 } })),
      monsters: begun.state.monsters.map((m) => ({ ...m, pos: monsterStart })),
      // Block the direct column hexes between them: (3,8), (3,7), (3,6).
      // Leave neighboring hexes open so monster can route around.
      obstacles: [
        { pos: { q: 3, r: 8 }, kind: "boulder" },
        { pos: { q: 3, r: 7 }, kind: "boulder" },
        { pos: { q: 3, r: 6 }, kind: "boulder" },
      ],
      turn_order: [MONSTER_ID, "U_RANGER"],
      turn_index: 0,
    };
    const result = step(withSetup, { kind: "monster_act" }, seqRoll([20, 10, 4]));
    const movedMonster = result.state.monsters.find((m) => m.id === MONSTER_ID);
    // Monster should have moved off its start — either left/right of the column to route around.
    expect(posKey(movedMonster!.pos!)).not.toBe(posKey(monsterStart));
    // And it must NOT have landed on any obstacle hex.
    const obstacleKeys = new Set(withSetup.obstacles!.map((o) => posKey(o.pos)));
    expect(obstacleKeys.has(posKey(movedMonster!.pos!))).toBe(false);
  });

  describe("loot tiles", () => {
    // The engine accumulates pickups in `state.pickups[fighterId]` when a
    // fighter's move action lands on a loot tile. Engine doesn't roll real
    // items — it just records the tier; the web worker resolves items at
    // victory time using the existing rollItem pipeline.

    function lootInit(): CombatInit {
      return {
        ...rangedInit(),
        scene_seed: 1234,
        scene: "cave",
      };
    }

    it("createCombatState seeds loot_tiles when scene_seed is set", () => {
      const state = createCombatState(lootInit());
      expect(state.loot_tiles).toBeDefined();
      expect(state.loot_tiles!.length).toBeGreaterThanOrEqual(1);
      expect(state.pickups).toEqual({});
    });

    it("scene_seed undefined → no loot tiles", () => {
      const state = createCombatState(rangedInit());
      expect(state.loot_tiles).toEqual([]);
    });

    it("walking onto a gold tile awards gold and removes the tile", () => {
      const begun = runBegin(createCombatState(lootInit()), [20, 5]);
      const fighter = begun.state.fighters[0];
      // Synthesize a tile adjacent to the fighter so a single move lands on it.
      // Pick a neighbor hex that's reachable (range >= 1 always).
      const neighbor = { q: fighter.pos!.q + 1, r: fighter.pos!.r };
      const tileId = "loot-test-gold";
      const withLoot: CombatState = {
        ...begun.state,
        loot_tiles: [{ id: tileId, pos: neighbor, kind: "gold", tier: 3 }],
        turn_phase: "move",
        turn_order: [fighter.id, "M1"],
        turn_index: 0,
      };
      const result = step(withLoot, { kind: "move", actor: fighter.id, to: neighbor }, seqRoll([]));
      // Tile removed
      expect(result.state.loot_tiles).toHaveLength(0);
      // Pickup recorded with the tier-3 gold formula (6 + 3*2 = 12)
      expect(result.state.pickups?.[fighter.id]).toEqual({ gold: 12, item_tile_tiers: [] });
      // Event emitted
      const pickupEvt = result.events.find((e) => e.type === "loot_pickup");
      expect(pickupEvt).toMatchObject({
        actor: fighter.id,
        tile_id: tileId,
        kind: "gold",
        gold: 12,
      });
      // Turn phase advanced as usual
      expect(result.state.turn_phase).toBe("attack");
    });

    it("walking onto an item tile records the item tier and removes the tile", () => {
      const begun = runBegin(createCombatState(lootInit()), [20, 5]);
      const fighter = begun.state.fighters[0];
      const neighbor = { q: fighter.pos!.q + 1, r: fighter.pos!.r };
      const withLoot: CombatState = {
        ...begun.state,
        loot_tiles: [{ id: "loot-test-item", pos: neighbor, kind: "item", tier: 5 }],
        turn_phase: "move",
        turn_order: [fighter.id, "M1"],
        turn_index: 0,
      };
      const result = step(withLoot, { kind: "move", actor: fighter.id, to: neighbor }, seqRoll([]));
      expect(result.state.loot_tiles).toHaveLength(0);
      // Item tier = max(1, source - 1) = 4
      expect(result.state.pickups?.[fighter.id]).toEqual({ gold: 0, item_tile_tiers: [4] });
      const pickupEvt = result.events.find((e) => e.type === "loot_pickup");
      expect(pickupEvt).toMatchObject({ kind: "item", item_tier: 4 });
    });

    it("multiple pickups by the same fighter accumulate", () => {
      const begun = runBegin(createCombatState(lootInit()), [20, 5]);
      const fighter = begun.state.fighters[0];
      const tilePos = { q: fighter.pos!.q + 1, r: fighter.pos!.r };
      const withLoot: CombatState = {
        ...begun.state,
        loot_tiles: [{ id: "t1", pos: tilePos, kind: "gold", tier: 2 }],
        pickups: { [fighter.id]: { gold: 5, item_tile_tiers: [3] } },
        turn_phase: "move",
        turn_order: [fighter.id, "M1"],
        turn_index: 0,
      };
      const result = step(withLoot, { kind: "move", actor: fighter.id, to: tilePos }, seqRoll([]));
      // Existing 5g + new tier-2 gold (6 + 2*2 = 10) = 15g
      expect(result.state.pickups?.[fighter.id]).toEqual({ gold: 15, item_tile_tiers: [3] });
    });

    it("moving to a hex with no tile does not touch pickups", () => {
      const begun = runBegin(createCombatState(lootInit()), [20, 5]);
      const fighter = begun.state.fighters[0];
      const neighbor = { q: fighter.pos!.q + 1, r: fighter.pos!.r };
      const empty: CombatState = {
        ...begun.state,
        loot_tiles: [],
        pickups: {},
        turn_phase: "move",
        turn_order: [fighter.id, "M1"],
        turn_index: 0,
      };
      const result = step(empty, { kind: "move", actor: fighter.id, to: neighbor }, seqRoll([]));
      expect(result.state.pickups).toEqual({});
      expect(result.events.find((e) => e.type === "loot_pickup")).toBeUndefined();
    });
  });
});
