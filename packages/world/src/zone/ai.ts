// The enemy's turn. An enemy plays by the heroes' rules: it has movement
// and one attack, it is struck at if it walks out of someone's reach, and
// fire burns it. It looks at every hex it could end on and asks what it
// could do from there: how hard it could hit and whom, whether getting
// there crosses fire or poison or draws a blow, and (for those that shoot)
// whether it is high ground with nobody breathing down its neck. Then it
// goes to the best one and attacks. If nothing it can reach lets it attack,
// it gives up its attack to run: twice as far, toward whoever is nearest.
// Taunted, it looks only at the one who taunted it first, and at the rest
// only if it can get no blow in on them this turn.

import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { enemyAct, walk } from "./combat";
import { attackContext, defenceOf, has, unseen, type Ctx } from "./engine";
import { adjacent, flies, inFight, pathIn, seesFor, zoneReach } from "./geometry";
import { AP_MAX, ENEMY_BURST, ENEMY_KIT, ITEM_AP, enemyStrikes, type EnemyStrike } from "./kit";
import { modsOf } from "./mods";
import { diceAverage, hitChance } from "./rules";
import { HARMFUL } from "./surfaces";
import type { Budget, Unit, ZoneState } from "./types";

interface Option {
  attack: EnemyStrike;
  target: Unit | null;
  worth: number;
}

/** The best attack an enemy could make standing on `pos`, and what it is worth, or null if it has none from there. */
function bestAttack(state: ZoneState, enemy: Unit, pos: HexPos, strikes: EnemyStrike[], heroes: Unit[]): Option | null {
  const there = { ...enemy, pos };
  const heaviest = Math.max(...strikes.map((s) => s.weight));
  let best: Option | null = null;
  const consider = (attack: EnemyStrike, target: Unit | null, worth: number) => {
    // An enemy's habits still count: the attack it favours gets the benefit of a close call.
    const scored = worth * (0.75 + (0.25 * attack.weight) / heaviest);
    if (!best || scored > best.worth) best = { attack, target, worth: scored };
  };
  for (const attack of strikes) {
    const average = diceAverage(attack.dice);
    if (attack.burst) {
      const caught = heroes.filter((h) => hexDistance(pos, h.pos) <= ENEMY_BURST && seesFor(state, enemy.side, pos, h.pos));
      // About half save for half: three quarters of the damage, to each one caught.
      if (caught.length > 0) consider(attack, null, caught.length * average * 0.75);
      continue;
    }
    for (const hero of heroes) {
      const dist = hexDistance(pos, hero.pos);
      if (attack.range === 1 ? dist !== 1 : dist > attack.range || dist === 0 || !seesFor(state, enemy.side, pos, hero.pos)) continue;
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
 * Play one enemy's turn. While it has the AP for an attack: move to the best hex it can reach with the AP an attack
 * leaves, and attack from it (again and again, as its AP allow). With nothing in reach, it spends all it has getting
 * closer. What AP it has left over it keeps for its next turn.
 */
export function enemyTurn(ctx: Ctx, enemy: Unit, budget: Budget): void {
  const { state } = ctx;
  if (state.aiOff) return;
  const strikes = enemyStrikes(enemy.kind, enemy.level, state.options.threat, modsOf(state.options).edge);
  // The Unseen are not there, as far as it knows.
  const standing = () => state.units.filter((u) => u.side === "hero" && !u.down && !unseen(u) && inFight(state, u.id));
  let heroes = standing();
  if (strikes.length === 0 || heroes.length === 0) return;
  const kit = ENEMY_KIT[enemy.kind] ?? {};
  const air = flies(enemy);
  const harmful = new Set(Object.entries(state.surfaces).filter(([, s]) => HARMFUL.has(s.kind)).map(([key]) => key));
  // The other side's coral cuts as well as fire does.
  for (const w of state.weather ?? []) if (w.kind === "coral" && w.side !== enemy.side) for (const p of w.hexes) harmful.add(posKey(p));
  let goaded = taunter(enemy, heroes);

  /**
   * The best place to end this move, weighing what could be done from there against what getting there costs, with blows only
   * at `targets`. `strike`: AP are kept back for an attack from there, and only the rest spent on getting there.
   */
  const chooseAmong = (targets: Unit[], strike: boolean): { path: HexPos[]; score: number; attacks: boolean } | null => {
    const nearest = (pos: HexPos) => Math.min(...targets.map((h) => hexDistance(pos, h.pos)));
    const movement = budget.move + Math.max(0, budget.ap - (strike ? ITEM_AP.attack : 0)) * budget.stride;
    // Two looks at the ground: one that will not set foot in fire or poison, and one that will.
    const clean = zoneReach(state, enemy, movement, air || harmful.size === 0 ? undefined : harmful);
    const any = air || harmful.size === 0 ? clean : zoneReach(state, enemy, movement);
    let best: { path: HexPos[]; score: number; attacks: boolean } | null = null;
    for (const [key, reached] of any) {
      if (!reached.stop) continue;
      const viaClean = clean.get(key);
      const path = pathIn(viaClean ? clean : any, reached.pos) ?? [];
      let score = -(viaClean ?? reached).cost * 0.05;
      // The ground on the way, and where it would end up standing.
      if (!air) score -= 4 * path.filter((p) => harmful.has(posKey(p))).length + (harmful.has(key) ? 2 : 0);
      // Blows drawn by walking out of reach.
      if (!budget.disengaged) {
        const drawn = new Set<string>();
        let from = enemy.pos;
        for (const step of path) {
          for (const h of heroes) if (adjacent(h.pos, from) && !adjacent(h.pos, step) && !state.encounter?.reacted.includes(h.id) && !has(h, "stunned") && !has(h, "prone")) drawn.add(h.id);
          from = step;
        }
        score -= 3 * drawn.size;
      }
      const option = strike ? bestAttack(state, enemy, reached.pos, strikes, targets) : null;
      if (option) {
        score += option.worth;
        // Two on one: a blow lands better with a friend already at the target's side.
        if (option.target && state.units.some((u) => u.id !== enemy.id && u.side === "enemy" && !u.down && adjacent(u.pos, option.target!.pos))) score += 1;
        // Those that shoot like room, and do not like company.
        if (kit.ranged) score += Math.min(nearest(reached.pos), 4) * 0.4;
      }
      // Nothing to hit from there: at least get closer.
      else score -= 50 + nearest(reached.pos);
      if (!best || score > best.score) best = { path, score, attacks: !!option };
    }
    return best;
  };
  /** Taunted: at the taunter if a blow can be got in on them, else as it would anyway. */
  const choose = (strike: boolean) => {
    const forced = goaded ? chooseAmong([goaded], strike) : null;
    return forced?.attacks ? forced : chooseAmong(heroes, strike);
  };

  for (let attacks = 0; attacks <= AP_MAX; attacks++) {
    if (enemy.down || has(enemy, "prone")) return;
    heroes = standing();
    if (heroes.length === 0) return;
    goaded = taunter(enemy, heroes);
    const plan = budget.ap >= ITEM_AP.attack ? choose(true) : null;
    if (!plan?.attacks) {
      // Nothing it can reach and still strike: before any blow, it spends all it has getting closer; after one, it waits.
      if (attacks === 0) {
        const run = choose(false);
        if (run && run.path.length > 0) walk(ctx, enemy, run.path, budget);
      }
      return;
    }
    if (plan.path.length > 0) walk(ctx, enemy, plan.path, budget);
    if (enemy.down || has(enemy, "prone") || budget.ap < ITEM_AP.attack) return;
    // It may not have got where it meant to: look again from where it stands.
    const still = standing();
    const goadedNow = taunter(enemy, still);
    const option = (goadedNow ? bestAttack(state, enemy, enemy.pos, strikes, [goadedNow]) : null) ?? (still.length > 0 ? bestAttack(state, enemy, enemy.pos, strikes, still) : null);
    if (!option) return;
    budget.ap -= ITEM_AP.attack;
    enemyAct(ctx, enemy, option.attack, option.target);
  }
}
