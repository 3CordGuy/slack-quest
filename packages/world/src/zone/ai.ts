// The enemy's turn. An enemy plays by the heroes' rules: it has movement,
// one attack and a bonus action, it is struck at if it walks out of
// someone's reach, and fire burns it. It looks at every hex it could end
// on and asks what it could do from there: how hard it could hit and whom,
// whether getting there crosses fire or poison or draws a blow, and (for
// those that shoot) whether it is high ground with nobody breathing down
// its neck. Then it goes to the best one and attacks.
//
// It knows the lie of the land. A ladder is a way up like any other, and
// a blow struck down one is better than a blow struck up it. One that can
// find no way on foot to anyone it could hit will leap a ledge to get
// there (a Jump, its bonus action). And one with hands, standing by
// someone who has a drop or a pit behind them, will try to shove them
// over it before it does anything else.
//
// If nothing it can reach lets it attack, it gives up its attack to run:
// twice as far, toward whoever is nearest. Taunted, it looks only at the
// one who taunted it first, and at the rest only if it can get no blow in
// on them this turn.

import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { checkCommon, doCommon, enemyAct, leavesReach, shiftInto, shoveDest, walk } from "./combat";
import { attackContext, defenceOf, has, saveBonus, unseen, type Ctx } from "./engine";
import { blast, close, elevOf, flies, inFight, pathIn, reachFrom, seesFor, strikes, zoneReach } from "./geometry";
import { ENEMY_BURST, ENEMY_KIT, JUMP_MOVE_COST, enemyShove, enemyStrikes, jumpRange, type EnemyStrike } from "./kit";
import { modsOf } from "./mods";
import { diceAverage, hitChance } from "./rules";
import { HARMFUL } from "./surfaces";
import type { Budget, Unit, ZoneState } from "./types";

interface Option {
  attack: EnemyStrike;
  target: Unit | null;
  worth: number;
}

/** Whether an attack of an enemy's reaches from `pos` to a hero: a blow by hand, by the rules of reach (strikes); a shot, by its range (further from above) and a clear line. */
export function strikeReaches(state: ZoneState, enemy: Unit, pos: HexPos, attack: EnemyStrike, hero: Unit): boolean {
  if (attack.range === 1) return strikes(state.map, pos, hero.pos);
  return hexDistance(pos, hero.pos) <= reachFrom(state.map, pos, hero.pos, attack.range) && seesFor(state, enemy.side, pos, hero.pos);
}

/** The best attack an enemy could make standing on `pos`, and what it is worth, or null if it has none from there. */
function bestAttack(state: ZoneState, enemy: Unit, pos: HexPos, blows: EnemyStrike[], heroes: Unit[]): Option | null {
  const there = { ...enemy, pos };
  const heaviest = Math.max(...blows.map((s) => s.weight));
  let best: Option | null = null;
  const consider = (attack: EnemyStrike, target: Unit | null, worth: number) => {
    // An enemy's habits still count: the attack it favours gets the benefit of a close call.
    const scored = worth * (0.75 + (0.25 * attack.weight) / heaviest);
    if (!best || scored > best.worth) best = { attack, target, worth: scored };
  };
  for (const attack of blows) {
    const average = diceAverage(attack.dice);
    if (attack.burst) {
      const caught = heroes.filter((h) => hexDistance(pos, h.pos) <= ENEMY_BURST && seesFor(state, enemy.side, pos, h.pos));
      // About half save for half: three quarters of the damage, to each one caught.
      if (caught.length > 0) consider(attack, null, caught.length * average * 0.75);
      continue;
    }
    for (const hero of heroes) {
      if (!strikeReaches(state, enemy, pos, attack, hero)) continue;
      const c = attackContext(state, there, hero, { melee: attack.range === 1 });
      let worth = hitChance(attack.bonus + c.mods, defenceOf(hero, state), c.adv) * average * (has(hero, "guarded") ? 0.5 : 1);
      // Go for the weak, finish the dying, and rise to a taunt.
      worth *= 1 + 0.5 * (1 - hero.hp / hero.maxHp);
      if (average >= hero.hp) worth += 3;
      if (has(hero, "taunting")) worth *= 3;
      consider(attack, hero, worth);
    }
  }
  return best;
}

/** The one who has taunted this unit (Taunt), if it is among `heroes`: who it must go for, if it can. */
function taunter(enemy: Unit, heroes: Unit[]): Unit | undefined {
  const by = enemy.conditions.find((c) => c.kind === "taunted")?.by;
  return by ? heroes.find((h) => h.id === by) : undefined;
}

/**
 * What shoving `hero` from where `enemy` stands would be worth: nothing unless it would send them into a pit or
 * over a drop of two levels or more, and they are not so sure-footed that it is hardly worth the try.
 */
function shoveWorth(state: ZoneState, enemy: Unit, hero: Unit): number {
  if (!strikes(state.map, enemy.pos, hero.pos) || has(hero, "prone")) return 0;
  const into = shiftInto(state, hero.pos, shoveDest(state, enemy.pos, hero.pos, hero), hero);
  if (!into || into.how === "open") return 0;
  // It has to win the shove, and then they have to fail to catch the edge.
  const win = hitChance(enemyShove(enemy.kind), 10 + Math.max(saveBonus(hero, "str"), saveBonus(hero, "agi")), 0);
  const prize = into.how === "pit" ? Math.max(8, hero.hp) : 2.5 * (into.levels - 1) + 2;
  return win * 0.5 * prize;
}

/** Shove whoever is best shoved over an edge from where the enemy stands, if anyone is worth the try (its bonus action). */
function tryShove(ctx: Ctx, enemy: Unit, budget: Budget, heroes: Unit[]): void {
  if (!budget.bonus || !ENEMY_KIT[enemy.kind]?.shoves || enemy.down || has(enemy, "prone")) return;
  const best = heroes
    .filter((h) => !h.down && !unseen(h))
    .map((h) => ({ h, worth: shoveWorth(ctx.state, enemy, h) }))
    .sort((a, b) => b.worth - a.worth || a.h.id.localeCompare(b.h.id))[0];
  if (!best || best.worth < 1.5) return;
  budget.bonus = false;
  doCommon(ctx, enemy, "shove", { target: best.h.id }, budget);
}

/** Play one enemy's turn: move to the best hex it can reach and attack from it. */
export function enemyTurn(ctx: Ctx, enemy: Unit, budget: Budget): void {
  const { state } = ctx;
  if (state.aiOff) return;
  const blows = enemyStrikes(enemy.kind, enemy.level, state.options.threat, modsOf(state.options).edge);
  // The Unseen are not there, as far as it knows.
  const seen = () => state.units.filter((u) => u.side === "hero" && !u.down && !unseen(u) && inFight(state, u.id));
  const heroes = seen();
  if (blows.length === 0 || heroes.length === 0) return;
  const kit = ENEMY_KIT[enemy.kind] ?? {};
  const air = flies(enemy);
  const harmful = new Set(Object.entries(state.surfaces).filter(([, s]) => HARMFUL.has(s.kind)).map(([key]) => key));
  // The other side's coral cuts as well as fire does.
  for (const w of state.weather ?? []) if (w.kind === "coral" && w.side !== enemy.side) for (const p of w.hexes) harmful.add(posKey(p));
  const goaded = taunter(enemy, heroes);

  // Someone with their back to a drop, right where it stands: over they go, before anything else.
  tryShove(ctx, enemy, budget, heroes);
  if (enemy.down) return;

  interface Plan { path: HexPos[]; score: number; attacks: boolean; leap?: HexPos }
  /** The best place to end this move, weighing what could be done from there against what getting there costs, with blows only at `targets`. */
  const chooseAmong = (targets: Unit[]): Plan | null => {
    const nearest = (pos: HexPos) => Math.min(...targets.map((h) => hexDistance(pos, h.pos)));
    // Two looks at the ground: one that will not set foot in fire or poison, and one that will.
    const clean = zoneReach(state, enemy, budget.move, air || harmful.size === 0 ? undefined : harmful);
    const any = air || harmful.size === 0 ? clean : zoneReach(state, enemy, budget.move);
    let best: Plan | null = null;
    /** What ending on `pos` is worth, come to by `path` at `cost`. */
    const weigh = (pos: HexPos, path: HexPos[], cost: number): { score: number; attacks: boolean } => {
      const key = posKey(pos);
      let score = -cost * 0.05;
      // The ground on the way, and where it would end up standing.
      if (!air) score -= 4 * path.filter((p) => harmful.has(posKey(p))).length + (harmful.has(key) ? 2 : 0);
      // Blows drawn by walking out of reach.
      if (!budget.disengaged) {
        const drawn = new Set<string>();
        let from = enemy.pos;
        for (const step of path) {
          for (const h of heroes) if (leavesReach(state, h.pos, from, step) && !state.encounter?.reacted.includes(h.id) && !has(h, "stunned") && !has(h, "prone")) drawn.add(h.id);
          from = step;
        }
        score -= 3 * drawn.size;
      }
      const option = budget.action ? bestAttack(state, enemy, pos, blows, targets) : null;
      if (option) {
        score += option.worth;
        // Two on one: a blow lands better with a friend already at the target's side.
        if (option.target && state.units.some((u) => u.id !== enemy.id && u.side === "enemy" && !u.down && close(u.pos, option.target!.pos))) score += 1;
        if (kit.ranged) {
          // Those that shoot like room, do not like company, and like to look down on what they shoot at.
          score += Math.min(nearest(pos), 4) * 0.4;
          if (option.target) score += Math.min(3, Math.max(0, elevOf(state.map, pos) - elevOf(state.map, option.target.pos))) * 0.5;
        }
      }
      // Nothing to hit from there: at least get closer.
      else score -= 50 + nearest(pos);
      return { score, attacks: !!option };
    };
    for (const [key, reached] of any) {
      if (!reached.stop) continue;
      const viaClean = clean.get(key);
      const path = pathIn(viaClean ? clean : any, reached.pos) ?? [];
      const w = weigh(reached.pos, path, (viaClean ?? reached).cost);
      if (!best || w.score > best.score) best = { path, ...w };
    }
    // No blow to be had on foot: is there a ledge to leap that would give one? (A Jump: its bonus action.)
    if (best && !best.attacks && budget.bonus && budget.action && !air && budget.move >= JUMP_MOVE_COST) {
      const range = jumpRange(0);
      for (const reached of clean.values()) {
        if (!reached.stop || reached.cost > budget.move - JUMP_MOVE_COST) continue;
        const from = { ...enemy, pos: reached.pos };
        for (const land of blast(state.map, reached.pos, range)) {
          if (clean.has(posKey(land)) || checkCommon(state, from, "jump", { at: land }, { ...budget, move: budget.move - reached.cost })) continue;
          const path = pathIn(clean, reached.pos) ?? [];
          const w = weigh(land, path, reached.cost + JUMP_MOVE_COST);
          if (w.attacks && w.score - 0.5 > best.score) best = { path, score: w.score - 0.5, attacks: true, leap: land };
        }
      }
    }
    return best;
  };
  /** Taunted: at the taunter if a blow can be got in on them, else as it would anyway. */
  const choose = () => {
    const forced = goaded ? chooseAmong([goaded]) : null;
    return forced?.attacks ? forced : chooseAmong(heroes);
  };

  let plan = choose();
  // Nothing in reach this turn: run. The attack is given up for twice the ground.
  if (plan && !plan.attacks && budget.action && budget.moveMax > 0) {
    budget.action = false;
    budget.move += budget.moveMax;
    ctx.events.push({ t: "used", id: enemy.id, what: "dash", name: "Dash" });
    plan = choose();
  }
  const wanted = plan && plan.path.length > 0 ? plan.path[plan.path.length - 1] : enemy.pos;
  if (plan && plan.path.length > 0) walk(ctx, enemy, plan.path, budget);
  if (enemy.down || has(enemy, "prone")) return;
  // Over the ledge, if that was the plan and it got to where it meant to leap from.
  if (plan?.leap && budget.bonus && enemy.pos.q === wanted.q && enemy.pos.r === wanted.r && !checkCommon(state, enemy, "jump", { at: plan.leap }, budget)) {
    budget.bonus = false;
    doCommon(ctx, enemy, "jump", { at: plan.leap }, budget);
    if (enemy.down || has(enemy, "prone")) return;
  }
  // It may not have got where it meant to: look again from where it stands.
  const still = seen();
  // Someone it has come up beside may have their back to a drop.
  tryShove(ctx, enemy, budget, still);
  if (enemy.down || has(enemy, "prone") || !budget.action) return;
  const now = seen();
  const goadedNow = taunter(enemy, now);
  const option = (goadedNow ? bestAttack(state, enemy, enemy.pos, blows, [goadedNow]) : null) ?? (now.length > 0 ? bestAttack(state, enemy, enemy.pos, blows, now) : null);
  if (!option) return;
  budget.action = false;
  enemyAct(ctx, enemy, option.attack, option.target);
}
