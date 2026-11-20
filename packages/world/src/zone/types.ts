// A zone: one self-contained map a party walks freely and fights on. The
// fights are played on the tiles themselves: everyone has a hex, a reach
// or a range, and the ground can be set alight, poisoned or frozen.
//
// This file is the shape of it. The rules are in rules.ts (dice), kit.ts
// (what each ability does on the tiles), surfaces.ts (the ground), ai.ts
// (the enemy's turn) and zone.ts (the reducer that ties them together).

import type { HexPos, Stats } from "@gantt-quest/core";
import type { EffectKind } from "../content";
import type { ItemDef, Outfit } from "../gear";
import type { ResourceKind, Resources } from "../hut";
import type { Clime, WorldMap } from "../map";
import type { FurnishingGrant } from "../drops";
import type { ZoneMod } from "./mods";

export type Side = "hero" | "enemy";

/**
 * What can be on a unit: the old fights' effects, three the tiles bring, the auras a hero can carry (kit.ts AURAS),
 * what the Rogue's tricks leave: Unseen (Sneak), and a fire bomb smuggled into the pack for a few turns (Contraband);
 * the Druid's: a heal that comes again each turn (Aqueous Regeneration), and a shell of coral (Coral Armor);
 * the Bard's: a shanty sung (song.ts), and Inspired (from joining one, or Lead by Example: the next roll to hit has advantage);
 * and the Sage's (stars.ts): Guiding Light on an enemy (whoever attacks it has advantage), North Star on an ally (their blows
 * set what they hit Burning), and a course charted (on the Sage: the mark their allies move faster toward);
 * and the Warden's: Taunted, on an enemy (it must go for the Warden who taunted it, if it can);
 * and the Warlock's (drowning.ts), all on an enemy: Drowning (stacks, `amount`), the Curse of Drowning, the Black Spot and Red Sky at Morning.
 */
export type Condition = EffectKind | "poisoned" | "wet" | "beacon" | "mending" | "bolstered" | "invisible" | "contraband" | "regenerating" | "rejuvenating" | "rallied" | "coral_armor" | ShantyKind | "inspired" | "guiding_light" | "north_star" | "charted" | "taunted" | "drowning" | "drowning_curse" | "black_spot" | "red_sky" | "tailwind";

/** The shanties a Bard sings (song.ts): a condition on the Bard, reaching everyone of theirs nearby. */
export type ShantyKind = "lively_shanty" | "dour_shanty" | "windgod_shanty";

export interface UnitCondition {
  kind: Condition;
  /** Turns of the bearer's own it has left. */
  rounds: number;
  /** Put on during the bearer's own turn: the end of that turn does not count against it. */
  fresh?: boolean;
  /** Bolstered: the points of shield left, spent before HP. Burning: its stacks (none said is one), each burning for the full tick. Drowning: its stacks. Tailwind: the movement it adds. */
  amount?: number;
  /** A course charted (Chart a Course): the hex marked. */
  at?: HexPos;
  /** A shanty: the allies who have joined it (each once), each widening it a hex. */
  joined?: string[];
  /** A shanty: the creatures called into the fight who have joined it (each once): only they get the lift of joining. */
  joinedOwn?: string[];
  /** A shanty: how many have joined it since the Bard's turn last began (the extra each joining gives lasts that long). */
  surge?: number;
  /** Taunted: the unit that taunted it. The Curse of Drowning and the Black Spot: who laid it. */
  by?: string;
}

/** What a hero carries to use in a zone: thrown at a hex, and (a healing potion) drunk. */
export type Throwable = "healing" | "poison" | "fire" | "oil" | "water" | "acid" | "slime" | "torch";

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
  /** A hero's lantern helm, shown or hidden (HeroSheet.lantern): it lights the dark round them. */
  lantern?: boolean;
  conditions: UnitCondition[];
  down: boolean;
  /** Rounds until each ability can be used again. */
  cooldowns: Record<string, number>;
  /** Rounds left on a lit torch held in a hand; none held when missing or 0. It burns only while a fight goes on. */
  torch?: number;
  /** The torch is in the main hand, swung as a weapon (else it is in the off hand, and the shield is set aside). */
  torchHand?: "main";
  /** The weapon's abilities, put away while a torch is swung in the main hand. */
  stowed?: string[];
  /** Heroes: the items they carry (potions, flasks, bombs), and how many of each. */
  items: Partial<Record<Throwable, number>>;
  /** Enemies: the group they stand with, and the post they go back to. */
  group?: string;
  home?: HexPos;
  /** A stand-in crewmate: the player who plays its turns. */
  controller?: string;
  /** Enemies: its pockets have been picked (Pickpocket pays once an enemy). */
  picked?: boolean;
  /** Enemies: gone into a pit (deep water, lava, off the edge of the land): it is down for good, and leaves no body to search. */
  lost?: "water" | "lava" | "void";
  /** Given a dev kit (DevOp "kit", the Maps tab): coming back to the map does not put the hero's own sheet back on. */
  devKit?: boolean;
  /**
   * A creature a hero has called into a fight (Summon Sea Turtle): on the hero's side, played by the hero's player
   * (`controller`) on the hero's initiative, and gone when it falls, when another is called in its place, or when the fight ends.
   */
  summon?: { by: string };
  /**
   * A hero whose player is not on the map (their last connection to it closed): nothing draws them into a
   * fight, and no enemy blow meant for a fight lands on them. A fight they were already in goes on with them in it.
   * Set by the server; cleared when the player comes back.
   */
  away?: boolean;
}

/** What a spell can leave hanging over (or standing on) some hexes (weather.ts). A wall (Fortify) is one too: nobody passes it. */
export type WeatherKind = "rain" | "wind" | "coral" | "wall";

export interface Weather {
  kind: WeatherKind;
  hexes: HexPos[];
  /** Rounds of a fight it has left. */
  rounds: number;
  /** Made this round: the end of it does not count against it. */
  fresh?: boolean;
  /** Who made it, and their side: the side it helps. */
  by: string;
  side: Side;
  /** Rain and coral: the turn (Encounter.turnNo, or -1 out of a fight) each unit was last healed or cut by it in. */
  touched: Record<string, number>;
}

export type SurfaceKind = "poison" | "fire" | "oil" | "water" | "ice" | "slime";

export interface GroundSurface {
  kind: SurfaceKind;
  /** Rounds of a fight it has left. Out of a fight it stays as it is. */
  rounds: number;
  /** Who laid it, for the log. */
  by: string | null;
  /** It does not wear off: the ground a map's modifier put there (zone/mods.ts). Whatever replaces it (water on fire) wears off as usual. */
  lasting?: boolean;
}

/**
 * What a unit has left to spend on its turn. A turn is Action Points (AP), spent on anything in any order: abilities,
 * common actions, items, and movement, bought `stride` steps at a time. AP left at the end of a turn carry over (AP_MAX at most).
 */
export interface Budget {
  /** Action Points left. */
  ap: number;
  /** Movement already bought this turn and not yet walked, in steps of open ground. Lost when the turn ends. */
  move: number;
  /** Steps of open ground 1 AP buys this turn: the unit's stride (heroMove, enemyMove), with whatever hastens or slows it. 0: it cannot move (knocked flat). */
  stride: number;
  /** Disengaged: moving away from an enemy draws no opportunity attack this turn. */
  disengaged: boolean;
  /**
   * How many more AP may go on movement this turn, for one that is held to so many: an enemy, to ENEMY_MOVE_AP (kit.ts).
   * Missing: as many as it has (a hero, and what a hero calls). Each stride bought takes one from it.
   */
  walk?: number;
  /** What a Wind-god's Shanty has added to `stride` this turn, so a shanty widened or begun mid-turn adds only what is still owed. */
  song?: number;
  /**
   * Movement from a course charted (Chart a Course) bought and left this turn: spent, before `move`, only on steps that bring
   * the unit nearer a mark. Each AP spent on movement buys CHART.speed more of it. Missing: no course was charted for it this
   * turn (one charted mid-turn gives it then).
   */
  course?: number;
}

export interface Encounter {
  round: number;
  /** Everyone in the fight, highest initiative first. The down stay in it and are passed over. */
  order: string[];
  init: Record<string, number>;
  /**
   * Nobody shares a place in the order: two who rolled the same initiative roll off against each other (and again,
   * should that be the same too), and this is what each rolled. The higher goes first.
   */
  tie?: Record<string, number>;
  /** Whose turn it is: one, and only ever one (a list from when heroes side by side in the order shared a turn). */
  acting: string[];
  /** Of `acting`, who has ended their turn. */
  done: string[];
  budgets: Record<string, Budget>;
  /** AP each unit ended its last turn with, carried into its next (AP_MAX at most). Missing: none. */
  banked?: Record<string, number>;
  /** Who has used their reaction this round. */
  reacted: string[];
  /** Turns begun so far. Keys the turn timer. */
  turnNo: number;
  /** Epoch ms when the server ends this turn. Set by the server, not the reducer. */
  deadline: number | null;
  /**
   * Heroes who fled this fight (Flee) and have not come back into it. One is drawn back in only by an enemy in
   * it coming within FLEE_RANGE (not by walking within JOIN_RANGE), and cannot reach into it from outside: no
   * blow, flask or help for anyone in it until they are back.
   */
  fled?: string[];
  /**
   * Heroes who have had their turn this round and fled on it: should they come back into the fight before the
   * round is out, they wait for the next one. Cleared as each round begins.
   */
  waits?: string[];
  /** Set when the one taking a turn flees and nobody else shared it: who came after them in the order (null: they were last), so the next turn goes there. */
  resume?: string | null;
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
  /** A delve into the caverns (zone/delve.ts): chambers, tunnels, chests and a hoard, not open ground. */
  delve?: boolean;
  /** What makes this map unlike the next (zone/mods.ts): changes to its ground and to whoever stands on it. */
  mods?: ZoneMod[];
  /**
   * Set on a map the atlas made (atlas.ts): how many rings out from the Harbor its node lies. Clearing
   * such a map pays everyone on it a bounty, and its fights pay by the enemy's level.
   */
  tier?: number;
  /** What the place is called, on a map the atlas made: its node's name. */
  name?: string;
  /** What kind of place it is: how its ground is laid out and what stands on it (zone/sites.ts). Left out: one that suits its ground and climate. */
  site?: string;
  /**
   * On a map the atlas made with a lodestone in its slot: how much that stone carried (0 for a plain one, up to 3).
   * The stones found in the place's spoils are reckoned from it (lodestone.ts `spoilStones`).
   */
  stone?: number;
  /** The climate it lies in, on a map the atlas made (left out for the greenwood): its ground is painted to suit. */
  clime?: Clime;
}

/**
 * One thing lying in something that can be looted (zone/spoils.ts): taken, it goes to the taker's own pack or purse.
 * `uid` is which thing it is among those it was found with: given when they are rolled and never used again, so a
 * `take` can name the thing itself and not its place in a list that others are taking from.
 */
export type LootItem = (
  | { t: "gold"; n: number }
  | { t: "res"; kind: ResourceKind; n: number }
  /** Something to drink or throw. */
  | { t: "use"; kind: Throwable; n: number }
  | { t: "gear"; item: ItemDef }
  /** A lodestone: what it carries. */
  | { t: "stone"; stone: ZoneMod[] }
  | { t: "blueprint"; id: string }
  | { t: "furnishing"; grant: FurnishingGrant }
) & { uid?: number };

/**
 * Something on the map with things in it to take: a fallen enemy, a chest thrown open, or the spoils of a place
 * cleared (zone/loot.ts). A body and a chest hold one lot of things, the same for everyone, first come first
 * served (`shared`); the spoils hold each hero's own share (`loot`).
 */
export interface LootSpot {
  /** A body keeps the id of whoever fell; a chest, its place's. */
  id: string;
  kind: "body" | "chest" | "spoils";
  name: string;
  pos: HexPos;
  /** A body: the enemy kind it was (it drives the figure lying there, and what it carried), and its level. */
  unit?: string;
  level?: number;
  /** A chest: which kind. */
  chest?: "chest" | "vault" | "hoard";
  /**
   * The spoils: what is in it, by hero: what is left of what was rolled for them. Missing: they have not looked yet.
   * Empty: they have taken it all. (A body or a chest on a map saved when those too were each hero's own, and
   * already looked into by someone then, keeps its shares here and is taken from as it was.)
   */
  loot: Record<string, LootItem[]>;
  /**
   * A body or a chest: what is left in it, for whoever takes it first. Rolled once, the first time anyone looks.
   * Missing: nobody has looked yet. Empty: it has all been taken (or there was nothing).
   */
  shared?: LootItem[];
  /** A body or a chest: who took each thing that has gone from it, by the thing's `uid`. */
  gone?: Record<number, string>;
}

export interface ZoneState {
  v: 1;
  code: string;
  seed: string;
  rng: number;
  options: ZoneOptions;
  /**
   * Its `tiles` array is shared by each state with the one before it (stepZone), and what is reckoned from an array
   * is kept with it. So a tile is never changed where it lies: whatever changes one puts a new tile in a new array.
   */
  map: WorldMap;
  /** Where heroes arrive, and wake after a lost fight. */
  start: HexPos;
  units: Unit[];
  /** Enemy groups by id: whether they have noticed the party. */
  groups: Record<string, { alerted: boolean }>;
  /** The ground, by hex key. */
  surfaces: Record<string, GroundSurface>;
  /** Weather spells have left over the ground (weather.ts). */
  weather?: Weather[];
  /** Torches lying lit on the ground, by hex: rounds of a fight left to burn, and who threw them. */
  lights?: Record<string, { rounds: number; by: string | null }>;
  /**
   * Time out of a fight (zone/clock.ts): when the last round of exploring was counted, and the last torch round.
   * Server time, in ms, as the room told it. Missing until the room first tells the time.
   */
  clock?: { at: number; torchAt: number };
  /** Keys to locked doors the party has found, all on one ring (zone/doors.ts). */
  keys?: number;
  /** The bands that carry a key: it is the party's once the band is beaten. */
  keyHolders?: string[];
  encounter: Encounter | null;
  /** The atlas's bounty for clearing this map has been paid (zone/loot.ts): it is paid once. */
  bounty?: boolean;
  /** What there is to loot (zone/loot.ts): the fallen, the chests that stand open, the spoils of the place. */
  loot?: LootSpot[];
  /** What kind of place it is (zone/sites.ts), and what lies under and round its land: the open sea, or a void it floats over. */
  scene?: { site: string; backdrop: string };
  /** For minting unit ids. */
  seq: number;
  /** Dev switches. */
  aiOff?: boolean;
  /**
   * A switch for the tests alone: heroes one after another in the order take their turns together, as fights
   * once went, so what one hero's ability does for another's can be tried within a single turn. Nothing sets
   * it in play: there, a turn is always one fighter's alone.
   */
  shareTurns?: boolean;
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
  /** A lantern helm on the head, shown or hidden (HeroSheet.lantern). */
  lantern?: boolean;
  maxHp: number;
  maxFocus: number;
  /** The class abilities they carry in, already checked against their class and level (classabilities.ts), on top of the weapon's. */
  classAbilities?: string[];
  /** What they carry to drink or throw, out of their own pack. A stand-in has no pack and is given the starting kit. */
  items?: Partial<Record<Throwable, number>>;
}

export type CommonAction = "disengage" | "help" | "shove" | "jump" | "flee" | "join";

export type DevOp =
  | { op: "spawn"; kinds: string[]; at: HexPos }
  | { op: "paint"; kind: SurfaceKind | null; hexes: HexPos[] }
  | { op: "standin"; classId: string }
  | { op: "heal" }
  | { op: "end_fight" }
  /** Set the nearest group that has not noticed anyone on whoever asked, wherever they stand. */
  | { op: "start_fight" }
  | { op: "ai"; off: boolean }
  | { op: "clear_surfaces" }
  /**
   * A dev kit (the Maps tab): make one of your own heroes (yourself, or a stand-in you play) a hero of this class and level, with
   * this weapon and any of the class's abilities (as many as you like). It holds until changed again, through a reload.
   */
  | { op: "kit"; unit: string; classId: string; weapon: string; level: number; abilities: string[] };

/** `by` is the player an action came from: the server sets it, never the client. */
export type ZoneAction =
  /** `near`: arrive beside this unit (a crewmate teleported to) and not at the start, unless they are in a fight. */
  | { type: "join"; hero: ZoneHero; near?: string }
  | { type: "move"; by: string; unit: string; to: HexPos }
  /** `target`: a unit's id, or a crate's (it is a poi on the map) for an ability that does damage. */
  | { type: "use"; by: string; unit: string; ability: string; target?: string; at?: HexPos; focus?: boolean }
  | { type: "common"; by: string; unit: string; what: CommonAction; target?: string; at?: HexPos }
  | { type: "throw"; by: string; unit: string; item: Throwable; at: HexPos }
  | { type: "drink"; by: string; unit: string; item: Throwable }
  /** Open a chest, strongbox or hoard (a cache on the map) from beside it. */
  | { type: "open"; by: string; unit: string; poi: string }
  /** Look into something lootable (a body, an open chest, the spoils) from beside it: what is in it is rolled the first time. */
  | { type: "loot"; by: string; unit: string; spot: string }
  /**
   * Take from it: the thing with this `uid`, or (neither given) all that is there. Out of a fight only. `index`,
   * the place in the list, names a thing only in a share of your own: a body or a chest is everyone's, and
   * what lies at a place in it may have changed since you looked.
   */
  | { type: "take"; by: string; unit: string; spot: string; index?: number; uid?: number }
  /** Light a torch from the pack and hold it: in the off hand, or in the main hand to swing as a weapon. */
  | { type: "light"; by: string; unit: string; hand?: "main" }
  /** Pick up a torch burning on the ground beside you: into a free hand still lit, or put out and into the pack. */
  | { type: "pickup"; by: string; unit: string; at: HexPos }
  /** Put out the lit torch in your hand and stow it in the pack: a weapon or shield set aside for it is taken up again. */
  | { type: "stow"; by: string; unit: string }
  /** Pick a cluster of glowing mushrooms from beside it, for a few mushrooms. */
  | { type: "forage"; by: string; unit: string; poi: string }
  /** Unlock a locked door from beside it with a key off the ring, or force it without one. */
  | { type: "unlock"; by: string; unit: string; poi: string }
  /** The server's own, never a client's: the time now, so time out of a fight can pass (zone/clock.ts). */
  | { type: "time"; now: number }
  | { type: "end_turn"; by: string; unit: string }
  | { type: "timeout" }
  /** The server's own, never a client's: a player has left the map (their last connection closed), or (false) is back. Their hero and stand-ins are `away`. */
  | { type: "away"; player: string; away: boolean }
  /** The server's own, never a client's: what a hero carries to drink or throw, as their pack holds it now. */
  | { type: "stock"; unit: string; items: Partial<Record<Throwable, number>> }
  | { type: "dev"; by: string; dev: DevOp };

/** Action types a player's client may send. `dev` is let through only on a development deployment. */
export const ZONE_CLIENT_ACTIONS: ReadonlySet<ZoneAction["type"]> = new Set(["move", "use", "common", "throw", "drink", "light", "pickup", "stow", "open", "loot", "take", "unlock", "forage", "end_turn", "dev"]);

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

/** Damage or healing dice as they fell, as shown in the log: "1d8 (6) + 3 = 9". */
export interface Rolled {
  /** The size of the dice: each of `faces` is one of them. */
  d: number;
  /** What each die showed. A critical hit rolls twice as many. */
  faces: number[];
  /** The flat part added to them. */
  plus: number;
  /** What they came to (before a save halved it, or a guard or a shield took its share). */
  total: number;
  crit?: boolean;
  /** The target saved, and took half. */
  halved?: boolean;
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
  /** `dice`: what was rolled for it, where dice were. */
  | { t: "hit"; actor: string | null; target: string; amount: number; what: string; crit: boolean; blocked?: number; dice?: Rolled }
  | { t: "miss"; actor: string; target: string; what: string }
  | { t: "heal"; actor: string | null; target: string; amount: number; what: string; dice?: Rolled }
  /** Someone drops off a height (shoved off it, or leaping from too high): how many levels. The harm follows as a `hit` by "fall". */
  | { t: "fell"; id: string; levels: number }
  /** Someone knocked toward a drop or a pit (`at`) catches the edge, and stays where they are. */
  | { t: "held"; id: string; at: HexPos }
  /** Someone goes into a pit: deep water, lava, or over the edge of the land. An enemy is gone; a hero is hauled back to the brink, down. */
  | { t: "sunk"; id: string; by: string | null; from: HexPos; into: HexPos; pit: "water" | "lava" | "void" }
  | { t: "condition"; target: string; kind: Condition; rounds: number; amount?: number }
  | { t: "tick"; target: string; kind: Condition | SurfaceKind; amount: number }
  /** Weather made over some hexes, or (`kind` null) cleared from them. */
  | { t: "weather"; kind: WeatherKind | null; hexes: HexPos[]; by: string }
  | { t: "skip"; id: string; kind: Condition }
  /** Drowning: it failed to hold its breath, and loses 2 of its AP this turn. */
  | { t: "choked"; id: string }
  | { t: "down"; id: string }
  | { t: "up"; id: string }
  | { t: "surface"; kind: SurfaceKind | null; hexes: HexPos[] }
  | { t: "burst"; hexes: HexPos[] }
  /** Driven from `from` to `to`, or flattened where it stands (`to` null). `pulled`: hauled toward `id` on a line, not struck back (Throw Pike, Harpoon); the number of this step of the haul, from 1. */
  | { t: "shoved"; id: string; target: string; from: HexPos; to: HexPos | null; pulled?: number }
  | { t: "jumped"; id: string; from: HexPos; to: HexPos }
  /** One who was Unseen gives themselves away. */
  | { t: "seen"; id: string }
  /** Gone from one hex and there on another, with nothing crossed between (Smuggler's Route, Tactical Retreat). */
  | { t: "blinked"; id: string; from: HexPos; to: HexPos }
  /** A creature is called into the fight (Summon Sea Turtle) by `by`; or one is gone (it fell, was replaced, or the fight is over). */
  | { t: "summoned"; id: string; by: string }
  | { t: "dismissed"; id: string }
  /** A hero gets away from the fight (Flee): out of the order, walking free. */
  | { t: "fled"; id: string }
  /** `fled`: every hero still standing got away, and none is left in it. */
  | { t: "fight_end"; outcome: "victory" | "defeat" | "fled" }
  /** A hero lights a torch to hold; a held torch burns out. */
  | { t: "lit"; id: string }
  | { t: "torch_out"; id: string }
  /** A torch lands burning on the ground (on), or burns out or is put out there (off). */
  | { t: "light"; at: HexPos; on: boolean }
  /** A hero takes up a torch from the ground: still lit in hand, or put out and stowed in the pack. */
  | { t: "took_torch"; id: string; at: HexPos; stowed: boolean }
  /** A hero puts out the torch in their hand and stows it in the pack. */
  | { t: "torch_stowed"; id: string }
  /** What a hero took, from a won fight or a chest: the XP, and whatever else came with it. */
  | { t: "spoils"; id: string; xp: number; resources: Resources; gold?: number; item?: string; blueprint?: string; furnishing?: string; potions?: number; torches?: number; /** A lodestone, in a bounty: what it carries. It goes to the crew's case. */ stone?: ZoneMod[] }
  /** A piece of gear found had no room in the pack: it went home to storage, or into the pack over its limit. Told by the server. */
  | { t: "stowed"; id: string; item: string; place: "storage" | "overfull" }
  /** A key goes on the party's ring: found in a chest (by `id`), or taken from a beaten band. */
  | { t: "key"; keys: number; from: "chest" | "band"; id?: string }
  /** A door is worked: unlocked with a key, forced open, or forced and held. */
  | { t: "door"; id: string; poi: string; how: "key" | "forced" | "held" }
  /** The crash of a forced door is heard by a band, which comes running. */
  | { t: "noise"; group: string }
  /** A fight in the open rouses the rest of the place: these bands, and everyone in them, are in it and on their way. */
  | { t: "roused"; groups: string[]; units: string[] }
  /** A cluster of glowing mushrooms is picked; what it gave follows as `spoils`. */
  | { t: "foraged"; id: string; poi: string }
  /** A chest, strongbox or hoard is opened. */
  | { t: "opened"; id: string; poi: string; loot: "chest" | "vault" | "hoard" }
  /** A hero looks into something lootable: what is in it (for them, if it is the spoils) is in the state they are sent. */
  | { t: "looked"; id: string; spot: string }
  /** A hero takes things out of it: out of what everyone could have taken, if it is a body or a chest. */
  | { t: "took"; id: string; spot: string; items: LootItem[] }
  /** A crate takes a blow, a blast or the fire under it. `actor` is who did it, if anyone did. */
  | { t: "crate_hit"; poi: string; actor: string | null; amount: number; what: string }
  /** A crate breaks open. `id` is whose blow (or fire) broke it, if anyone's. */
  | { t: "crate_broken"; poi: string; id: string | null }
  /** The last enemy group on the map is gone. */
  | { t: "cleared" }
  /** A map the atlas made has been cleared: its experience is paid (the `spoils` before this), and its spoils lie at `spot` for the taking. */
  | { t: "bounty"; spot?: string };

/** Things the server must carry out: what a player's own hero earned, from a won fight or a chest. */
export type ZoneEffect = {
  type: "grant";
  heroId: string;
  xp: number;
  resources: Resources;
  gold?: number;
  item?: ItemDef | null;
  blueprint?: string;
  furnishing?: FurnishingGrant;
  /** Put in the pack to drink or throw. */
  items?: Partial<Record<Throwable, number>>;
  /** A lodestone found in a bounty (lodestone.ts): it goes into the crew's case, not the hero's pack. */
  stone?: ZoneMod[];
};

export type ZoneStep = { ok: true; state: ZoneState; events: ZoneEvent[]; effects: ZoneEffect[] } | { ok: false; error: string };

/** What a client is sent: the zone, less its dice. */
/** `dark`: enemies in the fight that stand where the party cannot see them (those out of a fight are not sent at all). */
/** `loot`: of what there is to loot, each thing holds only what is in it for you. */
export type ZoneView = Omit<ZoneState, "rng" | "seed"> & { you: string; dark?: string[] };
