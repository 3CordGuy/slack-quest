import type { AbilityDef } from "../abilities";
import { fx } from "./effects";

const DRUID_PASSIVE_REGEN = 2;

export const druidAbilities: AbilityDef[] = [
  {
    kind: "active",
    id: "wildgrowth",
    name: "Wildgrowth",
    blurb: "Vines of legacy code constrict the foe.",
    icon: "grass",
    mana_cost: 1,
    routing: "damage",
    target: "single_enemy",
    execute(ctx) {
      const monster = ctx.target as { id: string; tier: number };
      const wpn = Math.max(0, ctx.caster.weapon_power);
      const t = Math.max(1, monster.tier);
      const best = Math.max(ctx.caster.attack_mod, ctx.caster.magic_mod);
      const r = ctx.roll(8);
      const amount = r + best + t + wpn;
      return [fx.damage(monster.id, amount, `1d8 + ${best} + ${t}t + ${wpn}w`, { drinkBuff: "ability" })];
    },
  },
  {
    kind: "active",
    id: "migrate",
    name: "Migrate",
    blurb: "Move any partymate to front or back without consuming their turn.",
    icon: "linked-rings",
    mana_cost: 1,
    routing: "utility",
    target: "single_ally",
    needs_position_picker: true,
    execute(ctx) {
      const target = ctx.target as { id: string; position: "front" | "back" } | undefined;
      const to = ctx.position;
      if (!target || !to || target.position === to) return [];
      return [fx.moveFighter(target.id, to)];
    },
  },
  {
    kind: "passive",
    id: "db_tree_communion",
    name: "Database-Tree Communion",
    blurb: "Regen +1 HP on every own action (always-on).",
    trigger: "on_action",
    once_per_fight: false,
    execute(ctx) {
      if (ctx.caster.hp <= 0) return [];
      const regenAmount = DRUID_PASSIVE_REGEN + Math.floor(ctx.caster.level / 6);
      const newHp = Math.min(ctx.caster.max_hp, ctx.caster.hp + regenAmount);
      const added = newHp - ctx.caster.hp;
      if (added <= 0) return [];
      return [fx.heal(ctx.caster.id, added)];
    },
  },
];
