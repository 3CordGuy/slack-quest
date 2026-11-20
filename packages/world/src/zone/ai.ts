// The enemy's turn. An enemy plays by the heroes' rules: it has Action
// Points to spend on moving and striking, it is struck at if it walks out
// of someone's reach, fire burns it, and it cannot walk through a hero: a
// hex one of them holds is closed to it, as theirs are to them. (It shares
// a hex with one of its own, as heroes do, and so brings two to a gap.) It
// looks at every hex it could end on and asks what it could do from there:
// how hard it could hit and whom, whether getting there crosses fire or
// poison or draws a blow, and (for those that shoot) whether it is high
// ground with nobody breathing down its neck. Then it goes to the best one
// and attacks, again and again as its AP allow.
//
// It does not go far in a turn: ENEMY_MOVE_AP of its AP at the most go on
// movement, whatever else it does, and the rest are kept if not struck with.
//
// It knows the lie of the land. A ladder is a way up like any other, and
// a blow struck down one is better than a blow struck up it. One that can
// find no way on foot to anyone it could hit will leap a ledge to get
// there (a Jump). And one with hands, standing by someone who has a drop
// or a pit behind them, will try to shove them over it before it does
// anything else.
//
// If nothing it can reach lets it attack, it heads for the nearest place
// from which it could, by the walking of it, round whoever holds the ground
// against it. Where the heroes hold the only way (a doorway, a bridge) and
// there is no room left before them, it comes up behind its own as near as
// it can get and waits its chance; and if what holds the way is someone it
// has no quarrel with just now (a hero lying there down, or one not in the
// fight), it leaps over them, where there is ground beyond to land on.
// Taunted, it looks only at the one who taunted it first, and at the rest
// only if it can get no blow in on them this turn.

import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { apForMove, checkCommon, doCommon, enemyAct, leavesReach, shiftInto, shoveDest, walk, walkAp } from "./combat";
import { attackContext, defenceOf, has, saveBonus, unseen, type Ctx } from "./engine";
import { HIGH_REACH, blast, close, elevOf, flies, heldAgainst, inFight, pathIn, reachFrom, sameHex, seesFor, stepCost, strikes, zoneReach, type Reached } from "./geometry";
import { AP_MAX, COMMON_ACTIONS, ENEMY_BURST, ENEMY_KIT, ITEM_AP, enemyShove, enemyStrikes, jumpRange, type EnemyStrike } from "./kit";
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
  // The lie of the land is looked up only where it could settle it: height adds up to HIGH_REACH to a range and takes nothing from it.
  const far = hexDistance(pos, hero.pos);
  if (far > attack.range + HIGH_REACH) return false;
  return (far <= attack.range || far <= reachFrom(state.map, pos, hero.pos, attack.range)) && seesFor(state, enemy.side, pos, hero.pos);
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
 * over a drop of two levels or more.
 */
function shoveWorth(state: ZoneState, enemy: Unit, hero: Unit): number {
  if (!strikes(state.map, enemy.pos, hero.pos) || has(hero, "prone")) return 0;
  const into = shiftInto(state, hero.pos, shoveDest(enemy.pos, hero.pos), hero);
  if (!into || into.how === "open") return 0;
  // It has to win the shove, and then they have to fail to catch the edge (about an even chance).
  const win = hitChance(enemyShove(enemy.kind), 10 + Math.max(saveBonus(hero, "str"), saveBonus(hero, "agi")), 0);
  const prize = into.how === "pit" ? Math.max(8, hero.hp) : 2.5 * (into.levels - 1) + 2;
  return win * 0.5 * prize;
}

/** Shove whoever is best shoved over an edge from where the enemy stands, if anyone is worth the AP. Says whether it did. */
function tryShove(ctx: Ctx, enemy: Unit, budget: Budget, heroes: Unit[]): boolean {
  const cost = COMMON_ACTIONS.shove.cost;
  if (budget.ap < cost || !ENEMY_KIT[enemy.kind]?.shoves || enemy.down || has(enemy, "prone")) return false;
  const best = heroes
    .filter((h) => !h.down && !unseen(h))
    .map((h) => ({ h, worth: shoveWorth(ctx.state, enemy, h) }))
    .sort((a, b) => b.worth - a.worth || a.h.id.localeCompare(b.h.id))[0];
  if (!best || best.worth < 1.5) return false;
  budget.ap -= cost;
  doCommon(ctx, enemy, "shove", { target: best.h.id }, budget);
  return true;
}

/**
 * How far ahead an enemy with nothing to strike this turn looks for a way to somewhere it could, in movement: near
 * at hand first, and then as far as any map goes.
 */
const APPROACH_LOOKS = [24, 400];

interface Plan {
  path: HexPos[];
  score: number;
  attacks: boolean;
  /** Where to leap to from the end of the path (a Jump), if the blow is only to be had from over a ledge. */
  leap?: HexPos;
}

/**
 * Play one enemy's turn. Anyone beside it with their back to a drop is shoved first, if it is the shoving kind.
 * Then, while it has the AP for an attack: move to the best hex it can reach with the AP an attack leaves (leaping
 * a ledge, if that is the only way to a blow), and attack from it, again and again as its AP allow. With nothing
 * in reach, it goes toward where there would be (approach). Either way no more than ENEMY_MOVE_AP of its AP go on
 * movement in the turn (Budget.walk, which walkAp reckons with). What AP it has left over it keeps for its next turn.
 */
export function enemyTurn(ctx: Ctx, enemy: Unit, budget: Budget): void {
  const { state } = ctx;
  if (state.aiOff) return;
  const blows = enemyStrikes(enemy.kind, enemy.level, state.options.threat, modsOf(state.options).edge);
  // The Unseen are not there, as far as it knows.
  const standing = () => state.units.filter((u) => u.side === "hero" && !u.down && !unseen(u) && inFight(state, u.id));
  let heroes = standing();
  if (blows.length === 0 || heroes.length === 0) return;
  const kit = ENEMY_KIT[enemy.kind] ?? {};
  const air = flies(enemy);
  const harmful = new Set(Object.entries(state.surfaces).filter(([, s]) => HARMFUL.has(s.kind)).map(([key]) => key));
  // The other side's coral cuts as well as fire does.
  for (const w of state.weather ?? []) if (w.kind === "coral" && w.side !== enemy.side) for (const p of w.hexes) harmful.add(posKey(p));
  let goaded = taunter(enemy, heroes);
  const jumpAp = COMMON_ACTIONS.jump.cost;

  /**
   * The best place to end this move, weighing what could be done from there against what getting there costs, with blows only
   * at `targets`. `strike`: AP are kept back for an attack from there, and only the rest spent on getting there.
   */
  const chooseAmong = (targets: Unit[], strike: boolean): Plan | null => {
    const nearest = (pos: HexPos) => Math.min(...targets.map((h) => hexDistance(pos, h.pos)));
    const movement = budget.move + walkAp(budget, strike ? ITEM_AP.attack : 0) * budget.stride;
    // Two looks at the ground: one that will not set foot in fire or poison, and one that will.
    const clean = zoneReach(state, enemy, movement, air || harmful.size === 0 ? undefined : harmful);
    const any = air || harmful.size === 0 ? clean : zoneReach(state, enemy, movement);
    /** What ending on `pos` is worth, come to by `path` at `cost`. */
    const weigh = (pos: HexPos, path: HexPos[], cost: number): { score: number; attacks: boolean } => {
      let score = -cost * 0.05;
      // The ground on the way, and where it would end up standing.
      if (!air) score -= 4 * path.filter((p) => harmful.has(posKey(p))).length + (harmful.has(posKey(pos)) ? 2 : 0);
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
      const option = strike ? bestAttack(state, enemy, pos, blows, targets) : null;
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
    let best: Plan | null = null;
    for (const [key, reached] of any) {
      if (!reached.stop) continue;
      const viaClean = clean.get(key);
      const path = pathIn(viaClean ? clean : any, reached.pos) ?? [];
      const w = weigh(reached.pos, path, (viaClean ?? reached).cost);
      if (!best || w.score > best.score) best = { path, ...w };
    }
    // No blow to be had on foot: is there a ledge to leap that would give one? (A Jump, and the AP it takes.)
    if (best && !best.attacks && strike && !air && budget.ap >= ITEM_AP.attack + jumpAp) {
      const afoot = budget.move + walkAp(budget, ITEM_AP.attack + jumpAp) * budget.stride;
      const range = jumpRange(0);
      for (const reached of clean.values()) {
        if (!reached.stop || reached.cost > afoot) continue;
        const from = { ...enemy, pos: reached.pos };
        // The way to where it would leap from is the same wherever it would land: found once, when first wanted.
        let path: HexPos[] | undefined;
        for (const land of blast(state.map, reached.pos, range)) {
          if (clean.has(posKey(land)) || checkCommon(state, from, "jump", { at: land }, budget)) continue;
          path ??= pathIn(clean, reached.pos) ?? [];
          const w = weigh(land, path, reached.cost + 2);
          if (w.attacks && w.score - 0.5 > best.score) best = { path, score: w.score - 0.5, attacks: true, leap: land };
        }
      }
    }
    return best;
  };
  /** Taunted: at the taunter if a blow can be got in on them, else as it would anyway. */
  const choose = (strike: boolean) => {
    const forced = goaded ? chooseAmong([goaded], strike) : null;
    return forced?.attacks ? forced : chooseAmong(heroes, strike);
  };

  /**
   * As much of `path` as `movement` covers over the ground as it is, ending where there is room to stand (out of fire and
   * poison, if any of it is), and what that much of it costs.
   */
  const along = (path: HexPos[], movement: number): { path: HexPos[]; cost: number } => {
    let [from, spent] = [enemy.pos, 0];
    let [keep, safe] = [{ n: 0, cost: 0 }, { n: 0, cost: 0 }];
    for (let i = 0; i < path.length; i++) {
      const step = stepCost(state, enemy, from, path[i]);
      if (!Number.isFinite(step.cost) || spent + step.cost > movement) break;
      spent += step.cost;
      from = path[i];
      if (!step.stop) continue;
      keep = { n: i + 1, cost: spent };
      if (air || !harmful.has(posKey(path[i]))) safe = keep;
    }
    const end = safe.n > 0 ? safe : keep;
    return { path: path.slice(0, end.n), cost: end.cost };
  };
  /**
   * Held up on `whole`, the way it would go, after walking `walked` of it: if the very next hex of it is one the other side
   * holds, the hex to leap to beyond them (a Jump: as far along the way as a leap from there lands), if it will have the AP
   * for one after the walk. Nothing, for what flies (it is barred like the rest) or with nowhere to land.
   */
  const leapOver = (whole: HexPos[], walked: { path: HexPos[]; cost: number }): HexPos | undefined => {
    const next = whole[walked.path.length];
    if (air || !next || !heldAgainst(state, next, enemy.side) || budget.ap - apForMove(budget, walked.cost) < jumpAp) return undefined;
    const from = { ...enemy, pos: walked.path[walked.path.length - 1] ?? enemy.pos };
    for (let i = whole.length - 1; i > walked.path.length; i--) {
      if (!harmful.has(posKey(whole[i])) && !checkCommon(state, from, "jump", { at: whole[i] }, budget)) return whole[i];
    }
    return undefined;
  };
  /**
   * Nothing to strike this turn: the way toward where there would be. It finds the hex nearest it, by the walking
   * (round whoever holds the ground against it, and through its own), that it could stand on and that any blow of its
   * would reach one of `targets` from, and goes along the way there as far as this turn's movement takes it. If the
   * heroes leave it no such hex (a doorway or a bridge held, and the ground before it full of its own), it takes the
   * way it would go were nobody standing anywhere, as far as that is open: up behind its friends, to wait its chance, or
   * up to whoever lies or stands in the way and is none of `targets`, and over them (`leap`, see leapOver).
   * It keeps out of fire and poison where there is another way. Null: the ground itself gives it no way to a blow.
   */
  const approach = (targets: Unit[]): { path: HexPos[]; leap?: HexPos } | null => {
    const movement = budget.move + walkAp(budget) * budget.stride;
    // Whether a blow could be struck from a hex is asked of the same hexes look after look (and by the flood as well as
    // of what it found), and nothing it depends on changes while a way is being looked for: each answer is kept.
    const blowAt = new Map<string, boolean>();
    const blowFrom = (pos: HexPos): boolean => {
      const key = posKey(pos);
      let can = blowAt.get(key);
      if (can === undefined) {
        can = blows.some((a) => targets.some((h) => (a.burst ? hexDistance(pos, h.pos) <= ENEMY_BURST && seesFor(state, enemy.side, pos, h.pos) : strikeReaches(state, enemy, pos, a, h))));
        blowAt.set(key, can);
      }
      return can;
    };
    const shuts = air || harmful.size === 0 ? [undefined] : [harmful, undefined];
    for (const ground of [state, { ...state, units: [enemy] }]) {
      // The looks that took in all the ground there is to reach and found no goal on it: looking further would find the same.
      const done = new Set<ReadonlySet<string> | undefined>();
      for (const far of APPROACH_LOOKS) {
        for (const shut of shuts) {
          if (done.has(shut)) continue;
          // The goal is the nearest hex a blow could be struck from, so the flood stops at the first it comes to (zoneReach
          // `enough`): any other as near is in the Map already, and the choice among them below falls as it always did.
          const told = { short: false };
          const reach = zoneReach(ground, enemy, far, shut, undefined, (r) => r.stop && blowFrom(r.pos), told);
          let goal: Reached | undefined;
          for (const r of reach.values()) if (r.stop && (!goal || r.cost < goal.cost) && blowFrom(r.pos)) goal = r;
          if (!goal) {
            if (!told.short) done.add(shut);
            continue;
          }
          const whole = pathIn(reach, goal.pos) ?? [];
          const walked = along(whole, movement);
          return { path: walked.path, leap: ground === state ? undefined : leapOver(whole, walked) };
        }
      }
    }
    return null;
  };

  // Someone with their back to a drop, right where it stands: over they go, before anything else.
  // One shove a turn: a hero who catches the edge is not shoved at it again and again.
  let shoved = tryShove(ctx, enemy, budget, heroes);

  for (let attacks = 0; attacks <= AP_MAX; attacks++) {
    if (enemy.down || has(enemy, "prone")) return;
    heroes = standing();
    if (heroes.length === 0) return;
    goaded = taunter(enemy, heroes);
    const plan = budget.ap >= ITEM_AP.attack ? choose(true) : null;
    if (!plan?.attacks) {
      // Nothing it can reach and still strike: before any blow, it goes toward where it could (at the one who taunted it, if
      // there is a way to them); after one, it waits. With no way over the ground to anyone, it at least gets as near as it can.
      if (attacks === 0) {
        const way = (goaded ? approach([goaded]) : null) ?? approach(heroes) ?? { path: choose(false)?.path ?? [], leap: undefined };
        const stand = way.path[way.path.length - 1] ?? enemy.pos;
        if (way.path.length > 0) walk(ctx, enemy, way.path, budget);
        // Over whoever holds the way and is not to be struck, if it got to where it meant to leap from. Then it may have a blow.
        if (way.leap && !enemy.down && !has(enemy, "prone") && sameHex(enemy.pos, stand) && budget.ap >= jumpAp && !checkCommon(state, enemy, "jump", { at: way.leap }, budget)) {
          budget.ap -= jumpAp;
          doCommon(ctx, enemy, "jump", { at: way.leap }, budget);
          continue;
        }
      }
      return;
    }
    const wanted = plan.path.length > 0 ? plan.path[plan.path.length - 1] : enemy.pos;
    if (plan.path.length > 0) walk(ctx, enemy, plan.path, budget);
    if (enemy.down || has(enemy, "prone")) return;
    // Over the ledge, if that was the plan and it got to where it meant to leap from.
    if (plan.leap) {
      if (enemy.pos.q !== wanted.q || enemy.pos.r !== wanted.r || budget.ap < jumpAp || checkCommon(state, enemy, "jump", { at: plan.leap }, budget)) return;
      budget.ap -= jumpAp;
      doCommon(ctx, enemy, "jump", { at: plan.leap }, budget);
      if (enemy.down || has(enemy, "prone")) return;
    }
    // Someone it has come up beside may have their back to a drop.
    if (!shoved) shoved = tryShove(ctx, enemy, budget, standing());
    if (enemy.down || has(enemy, "prone") || budget.ap < ITEM_AP.attack) return;
    // It may not have got where it meant to: look again from where it stands.
    const still = standing();
    const goadedNow = taunter(enemy, still);
    const option = (goadedNow ? bestAttack(state, enemy, enemy.pos, blows, [goadedNow]) : null) ?? (still.length > 0 ? bestAttack(state, enemy, enemy.pos, blows, still) : null);
    if (!option) return;
    budget.ap -= ITEM_AP.attack;
    enemyAct(ctx, enemy, option.attack, option.target);
  }
}
