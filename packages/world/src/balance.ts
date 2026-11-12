// Class balance simulation. Plays many seeded fights per class and per small
// party against the island's real encounters (roaming bands, camps, lairs),
// with a plain "sensible player" policy, and reports win rate, rounds to
// win, damage and healing per hero turn, and what the two passives (the
// Bard's aura, the Druid's regrowth) are worth. Deterministic: the same
// seeds give the same table. Not used by the game; balance.test.ts runs it.

import { FREE_POINTS_PER_LEVEL, LEVELUP_AUTO_ALLOC, STARTING_STATS, type Stats } from "@gantt-quest/core";
import { createBattle, currentActor, stepBattle, type BattleAction, type BattleEvent, type BattleState, type Combatant } from "./battle";
import { ABILITIES, ENEMIES, HERO_CLASSES, heroClass } from "./content";
import { heroCombatant, type HeroSheet } from "./hero";
import { makeRng } from "./rng";

/** An encounter as the game fields it, sized for the party where the game sizes it. */
export interface SimEncounter {
  id: string;
  /** Enemy kinds for a party of `n` heroes. */
  kinds: (n: number) => string[];
}

const band = (lead: "wolf" | "bandit"): SimEncounter => ({
  id: `band:${lead}`,
  // world.ts spawnRoamer: a lone hero meets one, a party a pair, four heroes a third.
  kinds: (n) => [lead, ...(n >= 2 ? [lead === "bandit" ? "archer" : "wolf"] : []), ...(n >= 4 ? [lead] : [])],
});
const fixed = (id: string, kinds: string[]): SimEncounter => ({ id, kinds: () => kinds });

/** The fights a voyage actually throws at a party (world.ts roamers, story.ts camps and lairs). */
export const SIM_ENCOUNTERS: SimEncounter[] = [
  band("wolf"),
  band("bandit"),
  fixed("camp:bandit+wolf", ["bandit", "wolf"]),
  fixed("camp:archer+bandit", ["archer", "bandit"]),
  fixed("camp:brute", ["brute"]),
  fixed("camp:3 wolves", ["wolf", "wolf", "wolf"]),
  fixed("camp:cultist+archer", ["cultist", "archer"]),
  fixed("lair:villain+brute", ["villain", "brute"]),
  fixed("lair:alpha+wolf", ["alpha", "wolf"]),
  fixed("lair:guardian", ["guardian"]),
];

export interface SimHero {
  classId: string;
  level: number;
  /** Defaults to the class's starting weapon. */
  weapon?: string;
  weaponPower?: number;
  armor?: number;
}

/** Stats at `level`: the class baseline, its auto-allocation, and free points into its main stat. */
export function simStats(classId: string, level: number): Stats {
  const out = { ...STARTING_STATS[classId] };
  const alloc = LEVELUP_AUTO_ALLOC[classId] ?? [];
  for (const k of alloc) out[k] += level - 1;
  if (alloc[0]) out[alloc[0]] += (level - 1) * FREE_POINTS_PER_LEVEL;
  return out;
}

function sheet(h: SimHero, i: number): HeroSheet {
  return {
    id: `h${i}`,
    name: `${h.classId}#${i}`,
    classId: h.classId,
    level: h.level,
    base: simStats(h.classId, h.level),
    bonus: {},
    weapon: h.weapon ?? heroClass(h.classId)!.weapons[0],
    weaponPower: h.weaponPower ?? 0,
    armor: h.armor ?? 0,
  };
}

const living = (s: BattleState, side: "hero" | "enemy") => s.combatants.filter((c) => c.side === side && !c.down);

/** Expected damage of one use, summed over the targets it would hit. */
function expectedDamage(s: BattleState, actor: Combatant, abilityId: string): number {
  const def = ABILITIES[abilityId];
  if (!def.damage) return 0;
  const p = (actor.pct[def.stat] ?? 45) / 100;
  const targets = def.target === "all_enemies" ? living(s, "enemy").length : 1;
  return (def.damage + actor.level + actor.power) * p * targets;
}

/** An enemy whose next move is a heavy single-target attack (8+ base damage) aimed at someone other than `not`. */
function bigSwingAt(e: Combatant, not: string): boolean {
  if (!e.intent || !e.intent.target || e.intent.target === not) return false;
  const a = ENEMIES[e.kind].attacks[e.intent.attack];
  return !!a && a.target === "hero" && a.damage >= 8;
}

/**
 * A plain, sensible player: heal an ally under half HP if you can; drink a
 * potion under a quarter; guard under a third if you have a guard; otherwise
 * use the attack with the best expected damage on the weakest enemy. Focus is
 * spent one at a time, only against a boss.
 */
export function choose(s: BattleState, actor: Combatant): BattleAction {
  const heals = actor.abilities.filter((a) => ABILITIES[a].target === "ally");
  const allies = living(s, "hero").sort((a, b) => a.hp / a.maxHp - b.hp / b.maxHp);
  const hurt = allies[0];
  if (heals.length && hurt && hurt.hp / hurt.maxHp < 0.5) {
    return { type: "ability", ability: heals[0], target: hurt.id, focus: 0 };
  }
  // Potions are free (once a turn): drink, then still act.
  if (actor.potions > 0 && !s.itemUsed && actor.hp / actor.maxHp < 0.25) return { type: "potion" };
  // A taunter steps in front of a big swing it can see coming at someone else.
  const taunt = actor.abilities.find((a) => ABILITIES[a].selfEffect?.effect === "taunting");
  if (taunt && living(s, "hero").length > 1 && living(s, "enemy").some((e) => bigSwingAt(e, actor.id))) {
    return { type: "ability", ability: taunt, target: living(s, "enemy")[0].id, focus: 0 };
  }
  const guard = actor.abilities.find((a) => ABILITIES[a].target === "self");
  if (guard && actor.hp / actor.maxHp < 0.34) return { type: "ability", ability: guard, focus: 0 };
  const attacks = actor.abilities.filter((a) => ABILITIES[a].damage);
  const best = attacks.sort((a, b) => expectedDamage(s, actor, b) - expectedDamage(s, actor, a))[0];
  const target = living(s, "enemy").sort((a, b) => a.hp - b.hp)[0];
  const focus = s.boss && actor.focus > 0 ? 1 : 0;
  return { type: "ability", ability: best, target: target.id, focus };
}

export interface FightTally {
  won: boolean;
  rounds: number;
  heroTurns: number;
  /** Direct and over-time damage the heroes dealt, per class id. */
  damage: Record<string, number>;
  /** Healing from abilities and passives, per class id (not potions). */
  healing: Record<string, number>;
  turns: Record<string, number>;
  /** Extra damage the Bard's aura added. */
  aura: number;
  /** HP the Druid's Deep Roots gave back. */
  regen: number;
  /** Heroes standing at the end. */
  standing: number;
  /** Each hero's HP, focus and potions after the fight, as the voyage keeps them (a downed winner gets up on 1 HP). */
  after: { hp: number; focus: number; potions: number }[];
}

export interface SimOptions {
  /** Strip the passives by disguising the class (the passives key off the class id). */
  noAura?: boolean;
  noRegen?: boolean;
}

/** One seeded fight, with rested heroes unless `carry` gives their HP, focus and potions. */
export function simFight(party: SimHero[], enemyKinds: string[], seed: number, opts: SimOptions = {}, carry?: FightTally["after"]): FightTally {
  const rng = makeRng(seed);
  const heroes = party.map((h, i) => {
    const c = heroCombatant(sheet(h, i));
    if (carry) Object.assign(c, carry[i]);
    if ((opts.noAura && c.kind === "frontend_bard") || (opts.noRegen && c.kind === "backend_druid")) c.kind = `${c.kind}~`;
    return c;
  });
  const classOf = new Map(heroes.map((h, i) => [h.id, party[i].classId]));
  const avgLevel = party.reduce((a, h) => a + h.level, 0) / party.length;
  const created = createBattle({ heroes, enemyKinds, avgLevel, poiId: null }, rng);
  let state = created.state;
  const tally: FightTally = { won: false, rounds: 0, heroTurns: 0, damage: {}, healing: {}, turns: {}, aura: 0, regen: 0, standing: 0, after: [] };
  const add = (rec: Record<string, number>, id: string, n: number) => {
    const cls = classOf.get(id);
    if (cls) rec[cls] = (rec[cls] ?? 0) + n;
  };
  // Who put each burn or bleed on whom, so ticks credit the right class.
  const dotOwner = new Map<string, string>();
  const read = (events: BattleEvent[], actorAbility?: { actor: Combatant; ability: string; scale?: number }) => {
    let scale = 0;
    for (const e of events) {
      if (e.t === "check" && actorAbility && e.actor === actorAbility.actor.id) scale = e.check.successes / e.check.rolls.length;
      if (e.t === "hit" && classOf.has(e.actor)) {
        add(tally.damage, e.actor, e.amount);
        const a = actorAbility?.actor;
        const def = ABILITIES[actorAbility?.ability ?? ""];
        if (a && def?.damage !== undefined && a.kind !== "frontend_bard") {
          const plain = Math.round((def.damage + a.level + a.power) * scale);
          if (e.amount > plain) tally.aura += e.amount - plain;
        }
      }
      if (e.t === "effect" && actorAbility && classOf.has(actorAbility.actor.id) && !classOf.has(e.target)) dotOwner.set(`${e.target}:${e.effect}`, actorAbility.actor.id);
      if (e.t === "tick" && !classOf.has(e.target)) {
        const owner = dotOwner.get(`${e.target}:${e.effect}`);
        if (owner) add(tally.damage, owner, e.amount);
      }
      if (e.t === "heal" && classOf.has(e.actor) && e.ability !== "Potion") {
        add(tally.healing, e.actor, e.amount);
        if (e.ability === "Deep Roots") tally.regen += e.amount;
      }
    }
  };
  read(created.events);
  for (let guard = 0; guard < 400 && state.status === "active"; guard++) {
    const actor = currentActor(state)!;
    const action = choose(state, actor);
    const res = stepBattle(state, actor.id, action, rng);
    if (!res.ok) throw new Error(`${actor.kind}: ${res.error}`);
    // A potion is free and keeps the turn, so it isn't a turn of its own.
    if (action.type !== "potion") {
      tally.heroTurns += 1;
      add(tally.turns, actor.id, 1);
    }
    // A Bard's aura counts only if a Bard is standing when the blow lands.
    const bardUp = living(state, "hero").some((h) => h.kind === "frontend_bard");
    read(res.events, action.type === "ability" && bardUp ? { actor, ability: action.ability } : action.type === "ability" ? { actor: { ...actor, kind: "frontend_bard" }, ability: action.ability } : undefined);
    state = res.state;
  }
  tally.won = state.status === "victory";
  // Turns per combatant: the timeline has no rounds, so this stands in for them.
  tally.rounds = state.turnNo / state.combatants.length;
  tally.standing = living(state, "hero").length;
  tally.after = state.combatants.filter((c) => c.side === "hero").map((c) => ({ hp: Math.max(1, c.hp), focus: c.focus, potions: c.potions }));
  return tally;
}

/** HP a hero gets back between fights on a voyage (berries, a shrine, a camp's rest), roughly. */
export const SIM_REST_HP = 6;

export interface GauntletTally {
  cleared: boolean;
  /** Fights won before the party fell (4 when cleared). */
  fightsWon: number;
  fights: FightTally[];
}

/**
 * A voyage's worth of fighting without going home: a roaming band, a camp,
 * another band, then the lair, with HP, focus and potions carried between
 * fights and a small rest in between. This is where sustain shows.
 */
export function simGauntlet(party: SimHero[], seed: number, opts: SimOptions = {}): GauntletTally {
  const pick = makeRng(seed ^ 0x5bd1e995);
  const bands = SIM_ENCOUNTERS.filter((e) => e.id.startsWith("band"));
  const camps = SIM_ENCOUNTERS.filter((e) => e.id.startsWith("camp"));
  const lairs = SIM_ENCOUNTERS.filter((e) => e.id.startsWith("lair"));
  const route = [pick.pick(bands), pick.pick(camps), pick.pick(bands), pick.pick(lairs)];
  const out: GauntletTally = { cleared: false, fightsWon: 0, fights: [] };
  let carry: FightTally["after"] | undefined;
  for (const [i, enc] of route.entries()) {
    const t = simFight(party, enc.kinds(party.length), seed * 131 + i, opts, carry);
    out.fights.push(t);
    if (!t.won) return out;
    out.fightsWon += 1;
    const maxHp = party.map((h, j) => heroCombatant(sheet(h, j)).maxHp);
    carry = t.after.map((v, j) => ({ ...v, hp: Math.min(maxHp[j], v.hp + SIM_REST_HP) }));
  }
  out.cleared = true;
  return out;
}

export interface GauntletRow {
  clearRate: number;
  fightsWon: number;
  dpt: number;
  hpt: number;
  auraShare: number;
  regenShare: number;
}

export function gauntletRow(party: SimHero[], seeds: number, opts: SimOptions = {}, focusClass?: string): GauntletRow {
  let cleared = 0, won = 0, dmg = 0, heal = 0, turns = 0, partyDmg = 0, partyHeal = 0, aura = 0, regen = 0;
  for (let seed = 1; seed <= seeds; seed++) {
    const g = simGauntlet(party, seed, opts);
    if (g.cleared) cleared += 1;
    won += g.fightsWon;
    for (const t of g.fights) {
      for (const cls of Object.keys(t.turns)) {
        if (focusClass && cls !== focusClass) continue;
        dmg += t.damage[cls] ?? 0;
        heal += t.healing[cls] ?? 0;
        turns += t.turns[cls] ?? 0;
      }
      partyDmg += Object.values(t.damage).reduce((a, b) => a + b, 0);
      partyHeal += Object.values(t.healing).reduce((a, b) => a + b, 0);
      aura += t.aura;
      regen += t.regen;
    }
  }
  return { clearRate: cleared / seeds, fightsWon: won / seeds, dpt: turns ? dmg / turns : 0, hpt: turns ? heal / turns : 0, auraShare: partyDmg ? aura / partyDmg : 0, regenShare: partyHeal ? regen / partyHeal : 0 };
}

export interface SimRow {
  label: string;
  fights: number;
  winRate: number;
  /** Mean rounds of the fights won. */
  roundsToWin: number;
  /** Per hero turn, for the class(es) of interest. */
  dpt: number;
  hpt: number;
  /** Share of the party's damage the Bard's aura supplied, and of its healing the Druid's regrowth supplied. */
  auraShare: number;
  regenShare: number;
}

/** Run `seeds` fights of a party against each encounter and fold them into one row. */
export function simRow(label: string, party: SimHero[], encounters: SimEncounter[], seeds: number, opts: SimOptions = {}, focusClass?: string): SimRow {
  let fights = 0, wins = 0, winRounds = 0, dmg = 0, heal = 0, turns = 0, partyDmg = 0, partyHeal = 0, aura = 0, regen = 0;
  for (const enc of encounters) {
    const kinds = enc.kinds(party.length);
    for (let seed = 1; seed <= seeds; seed++) {
      const t = simFight(party, kinds, seed * 7919 + enc.id.length * 31 + kinds.length, opts);
      fights += 1;
      if (t.won) {
        wins += 1;
        winRounds += t.rounds;
      }
      for (const cls of Object.keys(t.turns)) {
        if (focusClass && cls !== focusClass) continue;
        dmg += t.damage[cls] ?? 0;
        heal += t.healing[cls] ?? 0;
        turns += t.turns[cls] ?? 0;
      }
      partyDmg += Object.values(t.damage).reduce((a, b) => a + b, 0);
      partyHeal += Object.values(t.healing).reduce((a, b) => a + b, 0);
      aura += t.aura;
      regen += t.regen;
    }
  }
  return {
    label,
    fights,
    winRate: wins / fights,
    roundsToWin: wins ? winRounds / wins : 0,
    dpt: turns ? dmg / turns : 0,
    hpt: turns ? heal / turns : 0,
    auraShare: partyDmg ? aura / partyDmg : 0,
    regenShare: partyHeal ? regen / partyHeal : 0,
  };
}

export const SIM_CLASSES = HERO_CLASSES.map((c) => c.id);

/** Every unordered party of `size` drawn from the classes, repeats allowed. */
export function parties(size: number, classes = SIM_CLASSES): string[][] {
  const out: string[][] = [];
  const go = (start: number, acc: string[]) => {
    if (acc.length === size) return void out.push(acc);
    for (let i = start; i < classes.length; i++) go(i, [...acc, classes[i]]);
  };
  go(0, []);
  return out;
}

const pct = (n: number) => `${(n * 100).toFixed(0)}%`.padStart(5);
const num = (n: number) => n.toFixed(1).padStart(5);

/** The full report as text: single fights solo, then voyages (gauntlets) solo and in parties, then the passives. */
export function balanceReport(seeds = 40, level = 1): string {
  const lines: string[] = [];
  const at = (classId: string): SimHero => ({ classId, level, weaponPower: level >= 4 ? 2 : 0 });
  const encs = SIM_ENCOUNTERS;
  const trash = encs.filter((e) => !e.id.startsWith("lair"));
  const lairs = encs.filter((e) => e.id.startsWith("lair"));
  const g = Math.max(20, seeds * 5);
  lines.push(`== Level ${level}${level >= 4 ? ", weapon power 2" : ""}, starting weapons. Single fights: ${seeds} seeds per encounter, rested. Voyages: ${g} seeds of band, camp, band, lair with HP carried and +${SIM_REST_HP} HP between fights. ==`);
  lines.push("");
  lines.push("SOLO                 fight win: all  bands+camps  lairs | rounds | voyage clear  fights won | dmg/turn  heal/turn");
  for (const c of SIM_CLASSES) {
    const all = simRow(c, [at(c)], encs, seeds, {}, c);
    const t = simRow(c, [at(c)], trash, seeds, {}, c);
    const l = simRow(c, [at(c)], lairs, seeds, {}, c);
    const v = gauntletRow([at(c)], g, {}, c);
    lines.push(`${c.padEnd(20)}            ${pct(all.winRate)}   ${pct(t.winRate)}     ${pct(l.winRate)} |  ${num(all.roundsToWin)} |   ${pct(v.clearRate)}        ${num(v.fightsWon)}   |  ${num(v.dpt)}     ${num(v.hpt)}`);
  }
  for (const size of [2, 3]) {
    const ps = parties(size);
    const gs = Math.max(10, Math.round(g / 2));
    const rows = ps.map((p) => ({ p, v: gauntletRow(p.map(at), gs) }));
    lines.push("");
    lines.push(`PARTIES OF ${size}: voyages, ${gs} seeds per party; mean over the ${rows.filter((r) => r.p.includes(SIM_CLASSES[0])).length} parties each class is in   clear  fights won | own dmg/turn  heal/turn`);
    for (const c of SIM_CLASSES) {
      const mine = rows.filter((r) => r.p.includes(c));
      const mean = (f: (r: GauntletRow) => number, rs = mine.map((r) => r.v)) => rs.reduce((a, r) => a + f(r), 0) / rs.length;
      const own = mine.map((r) => gauntletRow(r.p.map(at), Math.max(5, Math.round(gs / 2)), {}, c));
      lines.push(`${c.padEnd(92)} ${pct(mean((r) => r.clearRate))}   ${num(mean((r) => r.fightsWon))}    |  ${num(mean((r) => r.dpt, own))}     ${num(mean((r) => r.hpt, own))}`);
    }
    const sorted = [...rows].sort((a, b) => a.v.clearRate - b.v.clearRate);
    lines.push(`  weakest: ${sorted.slice(0, 4).map((r) => `${r.p.join("+")} ${pct(r.v.clearRate).trim()}`).join(", ")}`);
    lines.push(`  strongest: ${sorted.slice(-4).reverse().map((r) => `${r.p.join("+")} ${pct(r.v.clearRate).trim()}`).join(", ")}`);
  }
  lines.push("");
  lines.push(`PASSIVES: voyages in a party of 2, ${g} seeds; clear rate with the passive vs without it, and its share of the party's damage or healing`);
  for (const [cls, opt, share] of [["frontend_bard", { noAura: true }, "auraShare"], ["backend_druid", { noRegen: true }, "regenShare"]] as const) {
    for (const partner of SIM_CLASSES) {
      const p = [at(cls), at(partner)];
      const on = gauntletRow(p, g);
      const off = gauntletRow(p, g, opt);
      lines.push(`  ${cls}+${partner}`.padEnd(36) + ` ${pct(on.clearRate)} vs ${pct(off.clearRate)}   ${share === "auraShare" ? "aura" : "regen"} = ${pct(on[share])} of party ${share === "auraShare" ? "damage" : "healing"}`);
    }
    const solo = gauntletRow([at(cls)], g);
    const soloOff = gauntletRow([at(cls)], g, opt);
    lines.push(`  ${cls} alone`.padEnd(36) + ` ${pct(solo.clearRate)} vs ${pct(soloOff.clearRate)}`);
  }
  return lines.join("\n");
}
