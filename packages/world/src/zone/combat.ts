// What units do: walk (and get struck at as they leave an enemy's reach),
// use an ability, take one of the common actions, throw something, and,
// for an enemy, make one of its attacks. Each has a check, which says in
// words why it cannot be done, and the doing. Costs and turns are the
// reducer's business (zone.ts); nothing here spends an Action.

import { hexDistance, hexNeighbors, posKey, type HexPos } from "@gantt-quest/core";
import { ABILITIES, ARMOR_DAMAGE_DIVISOR, BARD_AURA, WARLOCK_BLEED_TURNS, type AbilityDef } from "../content";
import { tileAt } from "../map";
import { DEBUFFS, addCondition, attackContext, attackRoll, damage, defenceOf, has, heal, removeCondition, saveBonus, saveRoll, type Ctx } from "./engine";
import { adjacent, blast, directionToward, elevOf, inFight, lineFrom, sameHex, sees, solid, stepCost, unitAt, unitById } from "./geometry";
import { COMMON_ACTIONS, ENEMY_BURST, JUMP_MOVE_COST, POTION_EDGE, SAVE_STAT, THROWABLES, abilityDice, enemyStrikes, healDice, jumpRange, reactionStrike, tacticOf, throwRange, type EnemyStrike, type Tactic } from "./kit";
import { d20, hitChance, mod, proficiency, rollDice, statOf } from "./rules";
import { chill, enterSurface, ignite, placeSurface } from "./surfaces";
import type { Budget, CommonAction, Throwable, Unit, ZoneState } from "./types";

/** How near a Bard has to be for their tune to help. */
export const BARD_AURA_RANGE = 3;
/** What a thrown bomb's blast is saved against. */
const THROW_SAVE = 12;

export interface Aim {
  target?: string;
  at?: HexPos;
}

// ---------- walking ----------

/**
 * Enemies beside `unit` that it is about to step out of reach of strike at it, if they still have
 * their reaction. Disengaged, it slips away untouched.
 */
function provoke(ctx: Ctx, unit: Unit, next: HexPos, budget: Budget | null, flush: () => void): void {
  const enc = ctx.state.encounter;
  if (!enc || !inFight(ctx.state, unit.id) || budget?.disengaged) return;
  for (const foe of ctx.state.units) {
    if (unit.down) return;
    if (foe.side === unit.side || foe.down || !inFight(ctx.state, foe.id)) continue;
    if (!adjacent(foe.pos, unit.pos) || adjacent(foe.pos, next) || sameHex(foe.pos, next)) continue;
    if (enc.reacted.includes(foe.id) || has(foe, "stunned") || has(foe, "prone")) continue;
    const blow = foe.side === "enemy" ? enemyStrikes(foe.kind, foe.level, ctx.state.options.threat).find((s) => s.range === 1 && !s.burst) : undefined;
    if (foe.side === "enemy" && !blow) continue;
    flush();
    enc.reacted.push(foe.id);
    ctx.events.push({ t: "reaction", id: foe.id, target: unit.id });
    if (blow) enemyAct(ctx, foe, blow, unit);
    else {
      const ability = reactionStrike(foe.abilities);
      strike(ctx, foe, ABILITIES[ability], tacticOf(ability), unit, {});
    }
  }
}

/** If someone else is on a unit's hex (it was stopped part-way past an ally), it shuffles to the nearest free one. */
function standClear(ctx: Ctx, unit: Unit): void {
  if (!ctx.state.units.some((u) => u.id !== unit.id && sameHex(u.pos, unit.pos))) return;
  const seen = new Set([posKey(unit.pos)]);
  const queue = [unit.pos];
  for (let i = 0; i < queue.length && i < 60; i++) {
    for (const n of hexNeighbors(queue[i], ctx.state.map.grid)) {
      if (seen.has(posKey(n))) continue;
      seen.add(posKey(n));
      if (solid(tileAt(ctx.state.map, n))) continue;
      if (!unitAt(ctx.state, n)) {
        unit.pos = n;
        ctx.events.push({ t: "moved", id: unit.id, path: [n] });
        return;
      }
      queue.push(n);
    }
  }
}

/**
 * Walk a unit along a path, a step at a time. Each step may draw an opportunity attack, costs
 * movement (when there is a budget), and lands the unit on whatever the ground holds. The walk
 * stops when the unit falls, slips, runs out of movement, or walks into a fight.
 */
export function walk(ctx: Ctx, unit: Unit, path: HexPos[], budget: Budget | null): void {
  let taken: HexPos[] = [];
  const flush = () => {
    if (taken.length > 0) ctx.events.push({ t: "moved", id: unit.id, path: taken });
    taken = [];
  };
  for (const next of path) {
    if (unit.down) break;
    const step = stepCost(ctx.state, unit, unit.pos, next);
    if (!Number.isFinite(step.cost) || (budget && step.cost > budget.move)) break;
    provoke(ctx, unit, next, budget, flush);
    if (unit.down) break;
    unit.pos = next;
    if (budget) budget.move -= step.cost;
    taken.push(next);
    if (enterSurface(ctx, unit, flush) || unit.down) break;
    if (ctx.onStep?.(unit, flush)) break;
  }
  flush();
  standClear(ctx, unit);
}

/** Knock `target` one hex directly away from `from`. Against a wall, a cliff or another body it takes a knock and falls Prone instead. */
export function push(ctx: Ctx, from: HexPos, target: Unit, by: string): void {
  const dir = directionToward(from, target.pos);
  const dest = { q: target.pos.q + dir.q, r: target.pos.r + dir.r };
  const open = !solid(tileAt(ctx.state.map, dest)) && Math.abs(elevOf(ctx.state.map, dest) - elevOf(ctx.state.map, target.pos)) < 2 && !unitAt(ctx.state, dest);
  const was = target.pos;
  if (!open) {
    ctx.events.push({ t: "shoved", id: by, target: target.id, from: was, to: null });
    damage(ctx, target, ctx.rng.int(1, 4), { actor: by, what: "shove" });
    addCondition(ctx, target, "prone", 1);
    return;
  }
  target.pos = dest;
  ctx.events.push({ t: "shoved", id: by, target: target.id, from: was, to: dest });
  enterSurface(ctx, target);
}

// ---------- a hero's abilities ----------

/** The hexes an ability covers, for one that takes a shape: what is lit up before it is used, and what it then hits. */
export function abilityArea(state: ZoneState, unit: Unit, ability: string, at?: HexPos): HexPos[] {
  const tactic = tacticOf(ability);
  if (tactic.shape === "blast") return at ? blast(state.map, at, tactic.radius ?? 1) : [];
  if (tactic.shape === "burst") return blast(state.map, unit.pos, tactic.radius ?? 1).filter((p) => !sameHex(p, unit.pos));
  if (tactic.shape === "line") return at ? lineFrom(state.map, unit.pos, at, tactic.length ?? 3) : [];
  if (tactic.shape === "adjacent") return hexNeighbors(unit.pos, state.map.grid);
  return [];
}

/** Why `unit` cannot use this ability on this aim, in words, or null if it can. */
export function checkAbility(state: ZoneState, unit: Unit, ability: string, aim: Aim): string | null {
  const def = ABILITIES[ability];
  if (!def || !unit.abilities.includes(ability)) return "You do not have that ability.";
  const tactic = tacticOf(ability);
  const inReach = (pos: HexPos): string | null => {
    const dist = hexDistance(unit.pos, pos);
    if (tactic.reach === "melee") return dist === 1 ? null : "Too far: you have to be next to it.";
    if (dist > tactic.range) return "Out of range.";
    return sees(state.map, unit.pos, pos) ? null : "There is no clear line to it.";
  };
  if (tactic.shape === "single" || tactic.shape === "chain") {
    const target = aim.target ? unitById(state, aim.target) : undefined;
    if (!target || target.down || target.side === unit.side) return "Pick an enemy.";
    return inReach(target.pos);
  }
  if (tactic.shape === "adjacent") {
    return state.units.some((u) => u.side !== unit.side && !u.down && adjacent(u.pos, unit.pos)) ? null : "No enemy is next to you.";
  }
  if (tactic.shape === "blast") {
    if (!aim.at || !tileAt(state.map, aim.at)) return "Pick a hex.";
    return inReach(aim.at);
  }
  if (tactic.shape === "line") return aim.at && !sameHex(aim.at, unit.pos) ? null : "Pick a direction.";
  if (tactic.shape === "ally") {
    const target = aim.target ? unitById(state, aim.target) : unit;
    if (!target || target.side !== unit.side) return "Pick an ally.";
    return target.id === unit.id ? null : inReach(target.pos);
  }
  return null;
}

/** What a hero adds to an ability's damage: their stat, their weapon, half their level, and a Bard's tune if one is near. */
function damageBonus(state: ZoneState, unit: Unit, def: AbilityDef): number {
  const tune = state.units.some((u) => u.id !== unit.id && u.side === unit.side && u.kind === "frontend_bard" && !u.down && hexDistance(u.pos, unit.pos) <= BARD_AURA_RANGE) ? BARD_AURA : 0;
  return mod(statOf(unit, def.stat)) + unit.power + Math.floor(unit.level / 2) + tune;
}

const saveDc = (unit: Unit, def: AbilityDef): number => 8 + proficiency(unit.level) + mod(statOf(unit, def.stat));

/** The conditions an ability leaves on a target it has got through to. */
function afflict(ctx: Ctx, unit: Unit, def: AbilityDef, target: Unit, save: boolean): void {
  if (target.down) return;
  if (def.perfect) {
    const effect = def.perfect.effect;
    if (!save || !saveRoll(ctx, target, SAVE_STAT[effect], saveDc(unit, def), `Resist ${def.name}`).ok) addCondition(ctx, target, effect, def.perfect.turns);
  }
  if (def.targetEffect && !target.down) addCondition(ctx, target, def.targetEffect.effect, def.targetEffect.turns);
}

/** One attack roll with an ability against one target. Returns whether it landed. */
function strike(ctx: Ctx, unit: Unit, def: AbilityDef, tactic: Tactic, target: Unit, opts: { focus?: boolean }): boolean {
  const melee = tactic.reach === "melee";
  const roll = attackRoll(ctx, unit, target, { label: def.name, bonus: proficiency(unit.level) + mod(statOf(unit, def.stat)) + (tactic.toHit ?? 0), melee, focus: opts.focus });
  if (!roll.ok) {
    ctx.events.push({ t: "miss", actor: unit.id, target: target.id, what: def.id });
    return false;
  }
  let amount = rollDice(ctx.rng, abilityDice(def), roll.crit) + damageBonus(ctx.state, unit, def);
  if (def.armorDamage) amount += Math.floor(unit.armor / ARMOR_DAMAGE_DIVISOR);
  if (def.maxHpDamage) amount += Math.round(target.maxHp * def.maxHpDamage);
  if (def.perDebuffDamage) amount += def.perDebuffDamage * DEBUFFS.filter((k) => has(target, k)).length;
  if (def.vsEffect && has(target, def.vsEffect.effect)) amount += def.vsEffect.bonus;
  if (tactic.vsWet && has(target, "wet")) amount += tactic.vsWet;
  if (def.bleedPayoff) {
    amount += def.bleedPayoff * (target.conditions.find((c) => c.kind === "bleeding")?.rounds ?? 0);
    removeCondition(target, "bleeding");
  }
  if (def.finisher && target.hp < target.maxHp / 4) amount *= def.finisher;
  const dealt = damage(ctx, target, amount, { actor: unit.id, what: def.id, crit: roll.crit, ignoreGuard: def.ignoreGuard });
  if (def.drain && dealt > 0 && !unit.down) heal(ctx, unit, Math.max(1, Math.round(dealt * def.drain)), { actor: unit.id, what: def.id });
  // A Warlock's critical hits open a wound.
  if (roll.crit && unit.kind === "data_warlock") addCondition(ctx, target, "bleeding", WARLOCK_BLEED_TURNS);
  afflict(ctx, unit, def, target, true);
  if (tactic.ignites) ignite(ctx, target.pos, unit.id);
  if (tactic.surface) placeSurface(ctx, [target.pos], tactic.surface.kind, tactic.surface.rounds, unit.id);
  return true;
}

/**
 * What an attack with this ability on this target would be rolled with, before it is made: the chance
 * to hit and why. Null for abilities that are saved against rather than rolled to hit.
 */
export function previewAttack(state: ZoneState, unit: Unit, ability: string, target: Unit): { chance: number; bonus: number; vs: number; adv: -1 | 0 | 1; notes: string[] } | null {
  const def = ABILITIES[ability];
  const tactic = tacticOf(ability);
  if (!def || !["single", "chain", "adjacent"].includes(tactic.shape)) return null;
  const c = attackContext(state, unit, target, { melee: tactic.reach === "melee" });
  const bonus = proficiency(unit.level) + mod(statOf(unit, def.stat)) + (tactic.toHit ?? 0) + c.mods;
  const vs = defenceOf(target);
  return { chance: hitChance(bonus, vs, c.adv), bonus, vs, adv: c.adv, notes: c.notes };
}

/** Use an ability that has passed its check. Says what was used, then rolls and applies it. */
export function resolveAbility(ctx: Ctx, unit: Unit, ability: string, aim: Aim & { focus?: boolean }): void {
  const def = ABILITIES[ability];
  const tactic = tacticOf(ability);
  const { state } = ctx;
  ctx.events.push({ t: "used", id: unit.id, what: ability, name: def.name, target: aim.target, at: aim.at });
  const foes = () => state.units.filter((u) => u.side !== unit.side && !u.down);
  let landed = false;
  if (tactic.shape === "single") {
    landed = strike(ctx, unit, def, tactic, unitById(state, aim.target!)!, aim);
  } else if (tactic.shape === "adjacent") {
    for (const foe of foes().filter((u) => adjacent(u.pos, unit.pos))) landed = strike(ctx, unit, def, tactic, foe, aim) || landed;
  } else if (tactic.shape === "chain") {
    const chain = [unitById(state, aim.target!)!];
    for (let i = 0; i < (tactic.jumps ?? 0); i++) {
      const last = chain[chain.length - 1];
      const next = foes()
        .filter((u) => !chain.includes(u) && hexDistance(u.pos, last.pos) <= 2 && sees(state.map, last.pos, u.pos))
        .sort((a, b) => hexDistance(a.pos, last.pos) - hexDistance(b.pos, last.pos) || a.id.localeCompare(b.id))[0];
      if (!next) break;
      chain.push(next);
    }
    for (const foe of chain) if (!foe.down) landed = strike(ctx, unit, def, tactic, foe, aim) || landed;
  } else if (tactic.shape === "blast" || tactic.shape === "burst" || tactic.shape === "line") {
    const area = abilityArea(state, unit, ability, aim.at);
    const keys = new Set(area.map(posKey));
    // A burst is thrown at the enemy; a blast or a line catches whoever is standing in it.
    const caught = state.units.filter((u) => !u.down && keys.has(posKey(u.pos)) && (tactic.shape !== "burst" || u.side !== unit.side));
    const rolled = rollDice(ctx.rng, abilityDice(def)) + damageBonus(state, unit, def);
    for (const victim of caught) {
      const saved = saveRoll(ctx, victim, "agi", saveDc(unit, def), def.name, aim.focus).ok;
      let amount = rolled;
      if (def.vsEffect && has(victim, def.vsEffect.effect)) amount += def.vsEffect.bonus;
      if (tactic.vsWet && has(victim, "wet")) amount += tactic.vsWet;
      damage(ctx, victim, saved ? Math.floor(amount / 2) : amount, { actor: unit.id, what: def.id, ignoreGuard: def.ignoreGuard });
      if (!saved) afflict(ctx, unit, def, victim, false);
    }
    landed = true;
    if (tactic.ignites) for (const pos of area) ignite(ctx, pos, unit.id);
    if (tactic.surface) placeSurface(ctx, area, tactic.surface.kind, tactic.surface.rounds, unit.id);
  } else {
    const target = tactic.shape === "ally" && aim.target ? unitById(state, aim.target)! : unit;
    if (def.heal) heal(ctx, target, rollDice(ctx.rng, healDice(def)) + Math.max(0, mod(statOf(unit, def.stat))) + Math.floor(unit.level / 2), { actor: unit.id, what: def.id });
    if (def.targetEffect) addCondition(ctx, target, def.targetEffect.effect, def.targetEffect.turns);
    // "Takes the very next turn" has no meaning in an initiative order: the ally is Hasted instead.
    if (def.actNext && target.id !== unit.id) addCondition(ctx, target, "hasted", 2);
    landed = true;
  }
  if (landed && def.selfEffect && !unit.down) addCondition(ctx, unit, def.selfEffect.effect, def.selfEffect.turns);
}

// ---------- an enemy's attacks ----------

/** One of an enemy's attacks: a blow or a shot at `target`, or (an attack on every hero) a burst around itself. */
export function enemyAct(ctx: Ctx, enemy: Unit, attack: EnemyStrike, target: Unit | null): void {
  const { state } = ctx;
  const dc = 8 + attack.bonus;
  ctx.events.push({ t: "used", id: enemy.id, what: "attack", name: attack.name, target: target?.id });
  const leave = (victim: Unit, save: boolean) => {
    if (victim.down || !attack.perfect) return;
    const effect = attack.perfect.effect;
    if (!save || !saveRoll(ctx, victim, SAVE_STAT[effect], dc, `Resist ${attack.name}`).ok) addCondition(ctx, victim, effect, attack.perfect.turns);
  };
  if (attack.burst) {
    const rolled = rollDice(ctx.rng, attack.dice);
    for (const victim of state.units.filter((u) => u.side !== enemy.side && !u.down && hexDistance(u.pos, enemy.pos) <= ENEMY_BURST && sees(state.map, enemy.pos, u.pos))) {
      const saved = saveRoll(ctx, victim, "agi", dc, attack.name).ok;
      damage(ctx, victim, saved ? Math.floor(rolled / 2) : rolled, { actor: enemy.id, what: attack.name });
      if (!saved) leave(victim, false);
    }
    return;
  }
  if (!target) return;
  const roll = attackRoll(ctx, enemy, target, { label: attack.name, bonus: attack.bonus, melee: attack.range === 1 });
  if (!roll.ok) {
    ctx.events.push({ t: "miss", actor: enemy.id, target: target.id, what: attack.name });
    return;
  }
  damage(ctx, target, rollDice(ctx.rng, attack.dice, roll.crit), { actor: enemy.id, what: attack.name, crit: roll.crit });
  leave(target, true);
  if (attack.kit.surface) placeSurface(ctx, [target.pos], attack.kit.surface.kind, attack.kit.surface.rounds, enemy.id);
  if (attack.kit.chills) chill(ctx, target.pos, enemy.id);
  if (attack.kit.push && !target.down) push(ctx, enemy.pos, target, enemy.id);
}

// ---------- common actions ----------

/** Why `unit` cannot take this common action, in words, or null if it can. `budget` is null out of a fight. */
export function checkCommon(state: ZoneState, unit: Unit, what: CommonAction, aim: Aim, budget: Budget | null): string | null {
  if (!COMMON_ACTIONS[what]) return "No such action.";
  if (what === "dash" || what === "disengage") return budget ? null : "That is for a fight.";
  if (what === "help") {
    const target = aim.target ? unitById(state, aim.target) : undefined;
    if (!target || target.side !== unit.side || !target.down) return "Pick a fallen ally.";
    return adjacent(target.pos, unit.pos) ? null : "You have to be next to them.";
  }
  if (what === "shove") {
    const target = aim.target ? unitById(state, aim.target) : undefined;
    if (!target || target.side === unit.side || target.down) return "Pick an enemy.";
    return adjacent(target.pos, unit.pos) ? null : "You have to be next to it.";
  }
  // Jump.
  if (!aim.at || sameHex(aim.at, unit.pos)) return "Pick a hex to jump to.";
  if (hexDistance(unit.pos, aim.at) > jumpRange(mod(statOf(unit, "str")))) return "Too far to jump.";
  if (solid(tileAt(state.map, aim.at)) || unitAt(state, aim.at)) return "There is nowhere to land.";
  if (elevOf(state.map, aim.at) - elevOf(state.map, unit.pos) > 1) return "Too high to jump up to.";
  if (!sees(state.map, unit.pos, aim.at)) return "Something is in the way.";
  if (budget && budget.move < JUMP_MOVE_COST) return "Not enough movement left to jump.";
  return null;
}

/** Take a common action that has passed its check. */
export function doCommon(ctx: Ctx, unit: Unit, what: CommonAction, aim: Aim, budget: Budget | null): void {
  ctx.events.push({ t: "used", id: unit.id, what, name: COMMON_ACTIONS[what].name, target: aim.target, at: aim.at });
  if (what === "dash" && budget) budget.move += budget.moveMax;
  else if (what === "disengage" && budget) budget.disengaged = true;
  else if (what === "help") {
    const target = unitById(ctx.state, aim.target!)!;
    target.down = false;
    target.hp = 0;
    ctx.events.push({ t: "up", id: target.id });
    heal(ctx, target, 1, { actor: unit.id, what: "help" });
  } else if (what === "shove") {
    const target = unitById(ctx.state, aim.target!)!;
    const roll = d20(ctx.rng, { kind: "shove", id: unit.id, target: target.id, label: "Shove", bonus: mod(statOf(unit, "str")), vs: 10 + Math.max(saveBonus(target, "str"), saveBonus(target, "agi")), adv: 0 });
    ctx.events.push({ t: "roll", roll });
    if (roll.ok) push(ctx, unit.pos, target, unit.id);
    else ctx.events.push({ t: "miss", actor: unit.id, target: target.id, what: "shove" });
  } else if (what === "jump") {
    const from = unit.pos;
    provoke(ctx, unit, aim.at!, budget, () => {});
    if (unit.down) return;
    unit.pos = aim.at!;
    if (budget) budget.move -= JUMP_MOVE_COST;
    ctx.events.push({ t: "jumped", id: unit.id, from, to: unit.pos });
    if (!enterSurface(ctx, unit) && !unit.down) ctx.onStep?.(unit, () => {});
  }
}

// ---------- throwing ----------

const carried = (unit: Unit, item: Throwable): number => unit.items[item] ?? 0;

/** Why `unit` cannot throw this there, in words, or null if it can. */
export function checkThrow(state: ZoneState, unit: Unit, item: Throwable, at: HexPos): string | null {
  if (!THROWABLES[item]) return "No such thing to throw.";
  if (carried(unit, item) <= 0) return `You have no ${THROWABLES[item].name.toLowerCase()} left.`;
  if (!tileAt(state.map, at)) return "Pick a hex.";
  if (hexDistance(unit.pos, at) > throwRange(mod(statOf(unit, "str")))) return "Too far to throw.";
  return sees(state.map, unit.pos, at) ? null : "There is no clear line to it.";
}

/** Why `unit` cannot drink this, in words, or null if it can. */
export function checkDrink(unit: Unit, item: Throwable): string | null {
  const def = THROWABLES[item];
  if (!def) return "No such thing to drink.";
  if (!def.drink) return `A ${def.name.toLowerCase()} is not for drinking.`;
  return carried(unit, item) > 0 ? null : `You have no ${def.name.toLowerCase()} left.`;
}

/** Drink something that has passed its check: all of its healing, for the drinker. */
export function drinkItem(ctx: Ctx, unit: Unit, item: Throwable): void {
  const def = THROWABLES[item];
  unit.items[item] = carried(unit, item) - 1;
  ctx.events.push({ t: "used", id: unit.id, what: `drink:${item}`, name: def.name });
  if (def.heal) heal(ctx, unit, rollDice(ctx.rng, def.heal), { actor: unit.id, what: `drink:${item}` });
}

/** Throw something that has passed its check: it lands on `at` and reaches the hexes around it. */
export function throwItem(ctx: Ctx, unit: Unit, item: Throwable, at: HexPos): void {
  const def = THROWABLES[item];
  unit.items[item] = carried(unit, item) - 1;
  ctx.events.push({ t: "used", id: unit.id, what: `throw:${item}`, name: def.name, at });
  const area = blast(ctx.state.map, at, def.radius);
  const keys = new Set(area.map(posKey));
  const caught = ctx.state.units.filter((u) => keys.has(posKey(u.pos)));
  if (def.heal) {
    const amount = rollDice(ctx.rng, def.heal);
    // It heals whoever it splashes, most of all whoever it lands on, and gets a fallen hero up. The enemy's dead stay dead.
    for (const u of caught) {
      if (u.down && u.side !== "hero") continue;
      heal(ctx, u, sameHex(u.pos, at) ? amount : Math.ceil(amount * POTION_EDGE), { actor: unit.id, what: `throw:${item}` });
    }
  }
  if (def.damage) {
    const rolled = rollDice(ctx.rng, def.damage);
    for (const u of caught.filter((c) => !c.down)) {
      const saved = saveRoll(ctx, u, "agi", THROW_SAVE, def.name).ok;
      damage(ctx, u, saved ? Math.floor(rolled / 2) : rolled, { actor: unit.id, what: `throw:${item}` });
    }
  }
  if (def.surface) placeSurface(ctx, area, def.surface.kind, def.surface.rounds, unit.id);
}
