// The contract dealer in the pub: personal contracts and the crew's shared goal.
//
// A contract is a side bet one hero takes in the ship's lobby. It pays a
// bonus if its terms are met on that voyage, and only if the story is won.
// A crew goal is one target the whole crew fills together over a period (a
// calendar week); every member is paid once when it is filled.
//
// Everything here is pure. The reducer in world.ts settles contracts when a
// run ends; the server adds crew-goal progress from what each step produced.

import type { BattleAction, BattleEvent } from "./battle";
import { RESOURCE_KINDS, RESOURCE_LABEL, type ResourceKind, type Resources } from "./hut";
import { makeRng, seedFromString } from "./rng";
import type { Hero, RunKind, WorldEffect, WorldEvent, WorldState } from "./world";

// ---------- tallies ----------

/** Things a contract needs counted that the state does not otherwise keep. */
export type TallyKey = "potions" | "perfects" | "downs" | "persuaded";

/** A hero's count for `key`. Voyages saved before tallies read as zero. */
export function tallyOf(hero: Pick<Hero, "tally">, key: TallyKey): number {
  return hero.tally?.[key] ?? 0;
}

export function bumpTally(hero: Pick<Hero, "tally">, key: TallyKey, n = 1): void {
  const tally = (hero.tally ??= {});
  tally[key] = (tally[key] ?? 0) + n;
}

/**
 * Count what happened in a batch of battle events: heroes knocked down and,
 * when `act` is the hero action that produced them, a potion drunk or an
 * ability whose every roll landed.
 */
export function tallyBattle(heroes: Hero[], events: BattleEvent[], act?: { heroId: string; action: BattleAction }): void {
  const byId = new Map(heroes.map((h) => [h.id, h]));
  for (const ev of events) {
    if (ev.t !== "down") continue;
    const hero = byId.get(ev.id);
    if (hero) bumpTally(hero, "downs");
  }
  const actor = act && byId.get(act.heroId);
  if (!act || !actor) return;
  if (act.action.type === "potion") bumpTally(actor, "potions");
  // The actor's own roll is the first check of the step; enemy turns follow it.
  const own = events.find((ev) => ev.t === "check" && ev.actor === actor.id);
  if (act.action.type === "ability" && own?.t === "check" && own.check.perfect) bumpTally(actor, "perfects");
}

// ---------- personal contracts ----------

export interface ContractReward {
  gold: number;
  resources?: Resources;
}

/** The parts of a voyage a contract may read. A player's client view has all of them. */
export type ContractView = Pick<WorldState, "facts" | "doom" | "map">;

export interface ContractDef {
  id: string;
  name: string;
  /** One line, written as the terms on the notice. */
  text: string;
  reward: ContractReward;
  /** Which kinds of run it can be taken on. Absent: a voyage only. */
  runs?: RunKind[];
  /** Whether `hero` meets the terms as the voyage stands. Checked for payment only on a won story. */
  check(state: ContractView, hero: Pick<Hero, "id" | "tally">): boolean;
}

/** The contract a hero took, and how it came out once the voyage ended. */
export interface TakenContract {
  id: string;
  outcome?: "met" | "failed";
}

export const SWIFT_DAYS = 5;
/** Days of torchlight still left when the crew climbs out, for the delve's own "quick" contract. */
export const TORCH_SPARE_DAYS = 4;
const BOTH: RunKind[] = ["voyage", "caverns"];
const DELVE: RunKind[] = ["caverns"];
export const PERFECTS_NEEDED = 3;

export const CONTRACTS: ContractDef[] = [
  {
    id: "scavenger",
    name: "Leave nothing behind",
    text: "See that both hidden caches on the island are searched.",
    reward: { gold: 25, resources: { wood: 2 } },
    check: (s) => !!s.facts["searched:cache1"] && !!s.facts["searched:cache2"],
  },
  {
    id: "camp",
    name: "Break the camp",
    text: "See the camp in the wilds cleared out.",
    reward: { gold: 30, resources: { fur: 2 } },
    check: (s) => !!s.facts["defeated:camp"],
  },
  {
    id: "swift",
    name: "Home before the tide",
    text: `Finish the story with ${SWIFT_DAYS} or more days still on the clock.`,
    reward: { gold: 40 },
    check: (s) => s.doom >= SWIFT_DAYS,
  },
  {
    id: "sober",
    runs: BOTH,
    name: "Dry voyage",
    text: "Do not drink a single potion in battle.",
    reward: { gold: 30 },
    check: (_s, hero) => tallyOf(hero, "potions") === 0,
  },
  {
    id: "flawless",
    runs: BOTH,
    name: "Clean work",
    text: `Use abilities in battle with every roll landing, ${PERFECTS_NEEDED} times.`,
    reward: { gold: 35, resources: { iron: 1 } },
    check: (_s, hero) => tallyOf(hero, "perfects") >= PERFECTS_NEEDED,
  },
  {
    id: "pilgrim",
    name: "Pay your respects",
    text: "Pray at the old shrine yourself.",
    reward: { gold: 20, resources: { stone: 2 } },
    check: (s, hero) => !!s.map.pois.find((p) => p.kind === "shrine")?.usedBy.includes(hero.id),
  },
  {
    id: "unbowed",
    runs: BOTH,
    name: "Still standing",
    text: "Never be knocked down in a fight.",
    reward: { gold: 35 },
    check: (_s, hero) => tallyOf(hero, "downs") === 0,
  },
  {
    id: "silver",
    name: "Silver tongue",
    text: "Win someone over with a Persuade roll of your own.",
    reward: { gold: 30, resources: { copper: 1 } },
    check: (_s, hero) => tallyOf(hero, "persuaded") >= 1,
  },
  // The Haunted Caverns' own.
  {
    id: "hoard",
    runs: DELVE,
    name: "Bring up the hoard",
    text: "See the hoard in the deepest chamber opened before the crew climbs out.",
    reward: { gold: 40, resources: { iron: 1 } },
    check: (s) => !!s.map.pois.find((p) => p.loot === "hoard")?.cleared,
  },
  {
    id: "chests",
    runs: DELVE,
    name: "Turn out every chest",
    text: "See every chest in the caverns opened, locked doors and all.",
    reward: { gold: 45, resources: { copper: 2 } },
    check: (s) => {
      const chests = s.map.pois.filter((p) => p.kind === "cache");
      return chests.length > 0 && chests.every((p) => p.cleared);
    },
  },
  {
    id: "torchlight",
    runs: DELVE,
    name: "Torches to spare",
    text: `Climb out with ${TORCH_SPARE_DAYS} or more days of torchlight left.`,
    reward: { gold: 30 },
    check: (s) => s.doom >= TORCH_SPARE_DAYS,
  },
];

/** The contracts on offer for a kind of run. */
export function contractsFor(kind: RunKind = "voyage"): ContractDef[] {
  return CONTRACTS.filter((c) => (c.runs ?? ["voyage"]).includes(kind));
}

export function contractById(id: string): ContractDef | undefined {
  return CONTRACTS.find((c) => c.id === id);
}

/** Whether a hero's taken contract is met as the voyage stands. False with no contract. */
export function contractMet(state: ContractView, hero: Pick<Hero, "id" | "tally" | "contract">): boolean {
  const def = hero.contract ? contractById(hero.contract.id) : undefined;
  return !!def && def.check(state, hero);
}

/** "30 gold, 2 Fur" */
export function rewardText(reward: ContractReward): string {
  const parts = [`${reward.gold} gold`];
  for (const kind of RESOURCE_KINDS) {
    const n = reward.resources?.[kind];
    if (n) parts.push(`${n} ${RESOURCE_LABEL[kind]}`);
  }
  return parts.join(", ");
}

// ---------- crew goals ----------

export type CrewGoalKind =
  | { kind: "voyages" }
  | { kind: "contracts" }
  | { kind: "hunt"; enemy: string }
  | { kind: "haul"; resource: ResourceKind };

export type CrewGoalDef = CrewGoalKind & {
  id: string;
  text: string;
  target: number;
  /** Gold paid to every member of the crew when the goal is filled. */
  reward: number;
};

export const CREW_GOALS: CrewGoalDef[] = [
  { id: "voyages", kind: "voyages", text: "Win 3 voyages", target: 3, reward: 40 },
  { id: "contracts", kind: "contracts", text: "Fulfil 4 contracts", target: 4, reward: 40 },
  { id: "hunt_wolf", kind: "hunt", enemy: "wolf", text: "Put down 6 dire wolves", target: 6, reward: 35 },
  { id: "hunt_bandit", kind: "hunt", enemy: "bandit", text: "Defeat 8 bandits", target: 8, reward: 35 },
  { id: "haul_wood", kind: "haul", resource: "wood", text: "Bring home 10 wood", target: 10, reward: 35 },
];

export function crewGoalById(id: string): CrewGoalDef | undefined {
  return CREW_GOALS.find((g) => g.id === id);
}

const DAY_MS = 24 * 60 * 60_000;

/** Monday 00:00 UTC of the week containing `ms`. */
function weekStart(ms: number): number {
  const d = new Date(ms);
  const sinceMonday = (d.getUTCDay() + 6) % 7;
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - sinceMonday);
}

/** A goal lasts one calendar week, Monday to Sunday in UTC. Named by ISO week, e.g. "2026-W46". */
export function goalPeriod(ms: number): string {
  // The ISO year and week number are those of the week's Thursday.
  const thursday = new Date(weekStart(ms) + 3 * DAY_MS);
  const week = Math.floor((thursday.getTime() - Date.UTC(thursday.getUTCFullYear(), 0, 1)) / (7 * DAY_MS)) + 1;
  return `${thursday.getUTCFullYear()}-W${String(week).padStart(2, "0")}`;
}

/** Epoch ms when the period containing `ms` ends and the next goal is posted. */
export function goalPeriodEnd(ms: number): number {
  return weekStart(ms) + 7 * DAY_MS;
}

/**
 * The goal a crew gets for a period: a seeded pick from the list, so it is
 * the same whoever asks first, and never the goal the crew had last.
 */
export function pickCrewGoal(crewId: string, period: string, previousId?: string | null): CrewGoalDef {
  const options = CREW_GOALS.filter((g) => g.id !== previousId);
  return makeRng(seedFromString(`goal|${crewId}|${period}`)).pick(options);
}

/**
 * How far one step of a voyage moves a crew goal. `prev` is the state before
 * the step (it still holds the battle, so a fallen enemy's kind can be read).
 */
export function crewGoalProgress(
  goal: CrewGoalKind,
  prev: Pick<WorldState, "battle">,
  step: { events: WorldEvent[]; effects: WorldEffect[] },
): number {
  let n = 0;
  if (goal.kind === "voyages") {
    for (const ev of step.events) if (ev.t === "ended" && ev.outcome === "victory") n += 1;
  } else if (goal.kind === "contracts") {
    for (const ev of step.events) if (ev.t === "contract" && ev.met) n += 1;
  } else if (goal.kind === "hunt") {
    const kinds = new Map((prev.battle?.combatants ?? []).filter((c) => c.side === "enemy").map((c) => [c.id, c.kind]));
    for (const ev of step.events) if (ev.t === "battle" && ev.ev.t === "down" && kinds.get(ev.ev.id) === goal.enemy) n += 1;
  } else {
    for (const fx of step.effects) if (fx.kind === "grant") n += fx.resources?.[goal.resource] ?? 0;
  }
  return n;
}
