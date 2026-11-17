// A zone: one self-contained map a party walks freely and fights on. The
// fights are played on the tiles themselves: everyone has a hex, a reach
// or a range, and the ground can be set alight, poisoned or frozen.
//
// This file is the shape of it. The rules are in rules.ts (dice), kit.ts
// (what each ability does on the tiles), surfaces.ts (the ground), ai.ts
// (the enemy's turn) and zone.ts (the reducer that ties them together).

import type { HexPos, Stats } from "@gantt-quest/core";
import type { EffectKind } from "../content";
import type { Outfit } from "../gear";
import type { Resources } from "../hut";
import type { WorldMap } from "../map";

export type Side = "hero" | "enemy";

/** What can be on a unit: the old fights' effects, and three the tiles bring. */
export type Condition = EffectKind | "poisoned" | "prone" | "wet";

export interface UnitCondition {
  kind: Condition;
  /** Turns of the bearer's own it has left. */
  rounds: number;
  /** Put on during the bearer's own turn: the end of that turn does not count against it. */
  fresh?: boolean;
}

/** What a hero carries to use in a zone: thrown at a hex, and (a healing potion) drunk. */
export type Throwable = "healing" | "poison" | "fire" | "oil" | "water";

export interface Unit {
  /** A hero's player id; `e<n>` for an enemy; `s<n>` for a stand-in crewmate. */
  id: string;
  side: Side;
  name: string;
  /** Class id for heroes, enemy kind for enemies. Drives the figure. */
  kind: string;
  level: number;
  pos: HexPos;
  hp: number;
  maxHp: number;
  focus: number;
  maxFocus: number;
  /** With gear, for heroes. Enemies have none: their numbers are derived from their kind (kit.ts). */
  stats?: Stats;
  armor: number;
  /** Added to a hero's damage. From the weapon in hand. */
  power: number;
  /** A hero's ability ids. Enemies attack with what their kind has. */
  abilities: string[];
  outfit?: Outfit;
  conditions: UnitCondition[];
  down: boolean;
  /** Rounds until each ability can be used again. */
  cooldowns: Record<string, number>;
  /** Heroes: the items they carry (potions, flasks, bombs), and how many of each. */
  items: Partial<Record<Throwable, number>>;
  /** Enemies: the group they stand with, and the post they go back to. */
  group?: string;
  home?: HexPos;
  /** A stand-in crewmate: the player who plays its turns. */
  controller?: string;
}

export type SurfaceKind = "poison" | "fire" | "oil" | "water" | "ice";

export interface GroundSurface {
  kind: SurfaceKind;
  /** Rounds of a fight it has left. Out of a fight it stays as it is. */
  rounds: number;
  /** Who laid it, for the log. */
  by: string | null;
}

/** What a unit has left to spend on its turn. */
export interface Budget {
  action: boolean;
  bonus: boolean;
  /** Movement left, in steps of open ground. */
  move: number;
  /** What a turn's movement was before any of it was spent (Dash adds this much again). */
  moveMax: number;
  /** Disengaged: moving away from an enemy draws no opportunity attack this turn. */
  disengaged: boolean;
}

export interface Encounter {
  round: number;
  /** Everyone in the fight, highest initiative first. The down stay in it and are passed over. */
  order: string[];
  init: Record<string, number>;
  /** Whose turn it is. Heroes next to each other in the order share one turn and act in any order. */
  acting: string[];
  /** Of `acting`, who has ended their turn. */
  done: string[];
  budgets: Record<string, Budget>;
  /** Who has used their reaction this round. */
  reacted: string[];
  /** Turns begun so far. Keys the turn timer. */
  turnNo: number;
  /** Epoch ms when the server ends this turn. Set by the server, not the reducer. */
  deadline: number | null;
}

export type ZoneSize = "small" | "medium" | "large";
export type ZoneBiome = "meadow" | "woods" | "caves" | "shore";

/** What a map is made from, besides its seed. The atlas will hand these out one day. */
export interface ZoneOptions {
  size: ZoneSize;
  biome: ZoneBiome;
  /** How many enemy groups stand on it. */
  groups: number;
  /** What leads each group, in turn. Empty: whatever suits the biome. */
  kinds: string[];
  /** 0 flat to 3 craggy. */
  elevation: number;
  /** 0 open to 3 cluttered. */
  obstacles: number;
  /** Open, empty ground around the start, in hexes: room to walk before a fight. */
  clear: number;
  /** How many heroes the groups are sized for, and their level. */
  party: number;
  level: number;
  /**
   * How dangerous the enemy is: 1 gentle, 2 a fair fight (the default), 3 hard. It sets how much
   * they can take, how well they hit, and how many stand in a group. Absent on zones made before it: 2.
   */
  threat?: number;
}

export interface ZoneState {
  v: 1;
  code: string;
  seed: string;
  rng: number;
  options: ZoneOptions;
  map: WorldMap;
  /** Where heroes arrive, and wake after a lost fight. */
  start: HexPos;
  units: Unit[];
  /** Enemy groups by id: whether they have noticed the party. */
  groups: Record<string, { alerted: boolean }>;
  /** The ground, by hex key. */
  surfaces: Record<string, GroundSurface>;
  encounter: Encounter | null;
  /** For minting unit ids. */
  seq: number;
  /** Dev switches. */
  aiOff?: boolean;
}

/** A hero walking in: the parts of their sheet a fight needs. */
export interface ZoneHero {
  id: string;
  name: string;
  classId: string;
  level: number;
  stats: Stats;
  weapon: string;
  weaponPower: number;
  armor: number;
  outfit?: Outfit;
  maxHp: number;
  maxFocus: number;
  /** What they carry to drink or throw, out of their own pack. A stand-in has no pack and is given the starting kit. */
  items?: Partial<Record<Throwable, number>>;
}

export type CommonAction = "dash" | "disengage" | "help" | "shove" | "jump";

export type DevOp =
  | { op: "spawn"; kinds: string[]; at: HexPos }
  | { op: "paint"; kind: SurfaceKind | null; hexes: HexPos[] }
  | { op: "standin"; classId: string }
  | { op: "heal" }
  | { op: "end_fight" }
  /** Set the nearest group that has not noticed anyone on whoever asked, wherever they stand. */
  | { op: "start_fight" }
  | { op: "ai"; off: boolean }
  | { op: "clear_surfaces" };

/** `by` is the player an action came from: the server sets it, never the client. */
export type ZoneAction =
  /** `near`: arrive beside this unit (a crewmate teleported to) and not at the start, unless they are in a fight. */
  | { type: "join"; hero: ZoneHero; near?: string }
  | { type: "move"; by: string; unit: string; to: HexPos }
  | { type: "use"; by: string; unit: string; ability: string; target?: string; at?: HexPos; focus?: boolean }
  | { type: "common"; by: string; unit: string; what: CommonAction; target?: string; at?: HexPos }
  | { type: "throw"; by: string; unit: string; item: Throwable; at: HexPos }
  | { type: "drink"; by: string; unit: string; item: Throwable }
  | { type: "end_turn"; by: string; unit: string }
  | { type: "timeout" }
  /** The server's own, never a client's: what a hero carries to drink or throw, as their pack holds it now. */
  | { type: "stock"; unit: string; items: Partial<Record<Throwable, number>> }
  | { type: "dev"; by: string; dev: DevOp };

/** Action types a player's client may send. `dev` is let through only on a development deployment. */
export const ZONE_CLIENT_ACTIONS: ReadonlySet<ZoneAction["type"]> = new Set(["move", "use", "common", "throw", "drink", "end_turn", "dev"]);

/** One d20 roll, as shown on the roll card. */
export interface Roll {
  kind: "attack" | "save" | "shove" | "initiative";
  /** Who rolled, and against whom or what. */
  id: string;
  target?: string;
  label: string;
  /** The dice as they fell: two when rolled with advantage or disadvantage. */
  d20: number[];
  /** The one that counted. */
  kept: number;
  bonus: number;
  total: number;
  /** What it had to reach: a Defence, a save's difficulty, or the other side's shove. */
  vs: number;
  /** 1 advantage, -1 disadvantage, 0 neither. */
  adv: -1 | 0 | 1;
  ok: boolean;
  crit: boolean;
}

export type ZoneEvent =
  | { t: "joined"; id: string }
  | { t: "moved"; id: string; path: HexPos[] }
  | { t: "alert"; group: string; by: string }
  | { t: "fight_start"; units: string[] }
  | { t: "fight_join"; id: string }
  | { t: "roll"; roll: Roll }
  | { t: "round"; n: number }
  | { t: "turn"; ids: string[] }
  /** Something done, said before its rolls: an ability, a common action, a throw, an enemy's attack by name. */
  | { t: "used"; id: string; what: string; name: string; target?: string; at?: HexPos }
  | { t: "reaction"; id: string; target: string }
  | { t: "hit"; actor: string | null; target: string; amount: number; what: string; crit: boolean }
  | { t: "miss"; actor: string; target: string; what: string }
  | { t: "heal"; actor: string | null; target: string; amount: number; what: string }
  | { t: "condition"; target: string; kind: Condition; rounds: number }
  | { t: "tick"; target: string; kind: Condition | SurfaceKind; amount: number }
  | { t: "skip"; id: string; kind: Condition }
  | { t: "down"; id: string }
  | { t: "up"; id: string }
  | { t: "surface"; kind: SurfaceKind | null; hexes: HexPos[] }
  | { t: "burst"; hexes: HexPos[] }
  | { t: "shoved"; id: string; target: string; from: HexPos; to: HexPos | null }
  | { t: "jumped"; id: string; from: HexPos; to: HexPos }
  | { t: "fight_end"; outcome: "victory" | "defeat" }
  /** What a hero took from a won fight: the XP it paid and the materials the fallen left. */
  | { t: "spoils"; id: string; xp: number; resources: Resources }
  /** The last enemy group on the map is gone. */
  | { t: "cleared" };

/** Things the server must carry out: what a player's own hero earned from a won fight. */
export type ZoneEffect = { type: "grant"; heroId: string; xp: number; resources: Resources };

export type ZoneStep = { ok: true; state: ZoneState; events: ZoneEvent[]; effects: ZoneEffect[] } | { ok: false; error: string };

/** What a client is sent: the zone, less its dice. */
export type ZoneView = Omit<ZoneState, "rng" | "seed"> & { you: string };
