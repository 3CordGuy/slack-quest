// The world reducer. One island, one story, one party.
//
// stepWorld(state, action) is pure and deterministic: the RNG state lives in
// WorldState, so a run can be replayed from its seed and action log. It
// returns the next state, the events to show players, and the effects the
// server must carry out (model calls, D1 writes).

import { hexDistance, type HexPos, type StatKey, type Stats } from "@gantt-quest/core";
import {
  createBattle,
  currentActor,
  stepBattle,
  type BattleAction,
  type BattleEvent,
  type BattleState,
  type Combatant,
} from "./battle";
import { rollCheck, statPct, type CheckResult } from "./check";
import { ENEMIES, KEY_ITEMS, WEAPONS } from "./content";
import { bumpTally, contractById, tallyBattle, type TakenContract, type TallyKey } from "./contracts";
import { battleDrops, cacheDrops, storyTrophy } from "./drops";
import { rollItem, type ItemDef, type Outfit } from "./gear";
import { freshVitals, heroCombatant } from "./hero";
import { addResources, capPerks, xpWithBonus, type Perk, type ResourceKind, type Resources } from "./hut";
import { capPubBuff } from "./pub";
import { brewBag, brewBuff } from "./apothecary";
import { MOVE_COST, PICKUP_MAX, findPath, generateMap, poiAt, poiById, tileAt, type Poi, type WorldMap } from "./map";
import {
  MAX_NPC_MESSAGES,
  MAX_PERSUADE_ATTEMPTS,
  MAX_PLAYER_TEXT,
  newNpcRun,
  validateIntent,
  type NpcOutput,
  type NpcRun,
} from "./npc";
import { voyageBoons } from "./projects";
import { addStats, applyXp, maxFocusFor, maxHpFor } from "./progression";
import { makeRng, seedFromString, type Rng } from "./rng";
import { NO_DEMAND, demandMet, validateBible, type StoryBible } from "./story";

export const MAX_PARTY = 4;
export const BATTLE_JOIN_RANGE = 2;
export const TALK_RANGE = 1;

/** What the server knows about a character when it boards. */
export interface HeroInit {
  id: string;
  name: string;
  classId: string;
  level: number;
  xp: number;
  unspent: number;
  /** Base stats, without gear. */
  base: Stats;
  /** Sum of equipped gear bonuses. */
  bonus: Partial<Stats>;
  weapon: string;
  /** Damage bonus from the equipped weapon. */
  weaponPower: number;
  /** Armor total from equipped gear. */
  armor: number;
  /** What the hero is visibly wearing, for drawing the sprite. */
  outfit?: Outfit;
  /** What their furnished hut gives them for this voyage. Held to PERK_CAPS when they board. */
  hutPerks?: Perk;
  /** What they ate and drank at the pub before sailing. Lasts this voyage only. */
  pubBuff?: Perk;
  /** The brews in their bag from the apothecary (ids, at most one of each). Used up when this voyage sails. */
  brews?: string[];
}

export interface Hero extends HeroInit {
  hp: number;
  maxHp: number;
  focus: number;
  maxFocus: number;
  potions: number;
  keyItems: string[];
  pos: HexPos;
  ready: boolean;
  /** The notice-board contract taken in the lobby. Absent on voyages saved before contracts. */
  contract?: TakenContract;
  /** Counts that contracts are judged on. Absent until something is counted. */
  tally?: Partial<Record<TallyKey, number>>;
}

export interface ChatLine {
  npcId: string;
  who: "hero" | "npc" | "system";
  name: string;
  text: string;
}

export interface Turn {
  heroId: string;
  /** Movement points left this turn. */
  mp: number;
  /** The movement roll, for display. */
  rolls: boolean[];
  /** The hero has used their one action this turn. */
  acted: boolean;
  /** Epoch ms when the server will end this turn. Set by the server, not the reducer. */
  deadline: number | null;
}

/** A piece of furniture or a trophy handed to a hero. */
export interface FurnishingGrant {
  defId: string;
  label: string;
}

export interface Earned {
  xp: number;
  gold: number;
  items: ItemDef[];
  /** Hut materials, learned blueprints and furnishings. Absent on voyages saved before huts. */
  resources?: Resources;
  blueprints?: string[];
  furnishings?: FurnishingGrant[];
}

export type Phase = "lobby" | "generating" | "overworld" | "battle" | "ended";

/** How far a hero sees, in hexes. One further from a hilltop. */
export const VISION = 2;
/** Roaming bands on the island when a voyage begins, and the most there can be at once. */
export const ROAMERS_AT_START = 2;
export const ROAMERS_MAX = 4;
/** A new band comes ashore every this many days, while there is room for one. */
export const ROAMER_EVERY_DAYS = 3;
/** A band that is this close to a hero makes for them; further off it only wanders. */
export const ROAMER_SCENT = 3;

export interface Roamer {
  id: string;
  /** Who is in the band, as enemy kinds. */
  kinds: string[];
  pos: HexPos;
}

/** What a forest hex can turn up as a hero walks through it. */
export type ForageKind = "berries" | "wood" | "bones" | "treasure" | "wolves";

/**
 * Chance, out of 100, of each find on a forest hex nobody has crossed before.
 * The rest of the time the trees are just trees.
 */
export const FORAGE_ODDS: Record<ForageKind, number> = { wood: 13, berries: 10, bones: 7, wolves: 6, treasure: 4 };
/** HP a handful of berries gives back. */
export const BERRY_HEAL = 3;

export interface WorldState {
  v: 1;
  code: string;
  seed: string;
  rng: number;
  /**
   * Hexes the party has seen (as "q,r"). Everything else is fog: it is not sent to clients and cannot be
   * walked into. Absent on voyages begun before there was fog, which have none.
   */
  seen?: string[];
  /** Enemy bands loose on the island. They wander, close on heroes they scent, and attack when they reach one. */
  roamers?: Roamer[];
  roamerSeq?: number;
  /** Forest hexes already walked through (as "q,r"). Each can turn something up only once a voyage. */
  forest?: string[];
  phase: Phase;
  hostId: string | null;
  map: WorldMap;
  bible: StoryBible | null;
  heroes: Hero[];
  /** Hero ids in overworld turn order. */
  order: string[];
  turnIdx: number;
  round: number;
  /** Rounds left before the villain escapes. */
  doom: number;
  turn: Turn | null;
  facts: Record<string, boolean>;
  npcs: Record<string, NpcRun>;
  chat: ChatLine[];
  battle: (BattleState & { npcId: string | null; deadline: number | null }) | null;
  result: { outcome: "victory" | "defeat"; reason: string; epilogue: string | null } | null;
  earned: Record<string, Earned>;
  /** Harbor projects the crew had built when this voyage was launched. Absent on voyages saved before projects. */
  projects?: string[];
}

export type WorldAction =
  | { type: "join"; hero: HeroInit }
  | { type: "ready"; heroId: string; ready: boolean }
  | { type: "start"; heroId: string }
  | { type: "contract"; heroId: string; contractId: string | null }
  | { type: "begin"; bible: StoryBible }
  | { type: "move"; heroId: string; to: HexPos }
  | { type: "interact"; heroId: string }
  | { type: "end_turn"; heroId: string }
  | { type: "timeout" }
  | { type: "talk"; heroId: string; npcId: string; text: string; persuade?: boolean; focus?: number }
  | { type: "npc_reply"; npcId: string; heroId: string; output: NpcOutput }
  | { type: "battle"; heroId: string; action: BattleAction }
  | { type: "gear"; heroId: string; gear: Pick<HeroInit, "base" | "unspent" | "bonus" | "weapon" | "weaponPower" | "armor" | "outfit"> }
  | { type: "epilogue"; text: string };

/** Action types a player's client may send. Everything else is server-only. */
export const CLIENT_ACTIONS: ReadonlySet<WorldAction["type"]> = new Set([
  "ready",
  "start",
  "contract",
  "move",
  "interact",
  "end_turn",
  "talk",
  "battle",
]);

export type WorldEvent =
  | { t: "joined"; heroId: string; name: string }
  | { t: "phase"; phase: Phase }
  /** Something a built Harbor project did for this voyage, said once as it opens. */
  | { t: "harbor_boon"; projectId: string; text: string }
  | { t: "turn_start"; heroId: string; mp: number; check: CheckResult }
  | { t: "round"; round: number; doom: number }
  | { t: "moved"; heroId: string; path: HexPos[] }
  | { t: "poi_revealed"; poiId: string }
  | { t: "check"; heroId: string; check: CheckResult }
  | { t: "rest"; heroId: string; hp: number; focus: number; where: string }
  | { t: "search"; heroId: string; found: boolean }
  /** A roaming band has caught a hero, or a hero has walked into one. */
  | { t: "ambush"; heroId: string; kinds: string[]; by: "band" | "hero" }
  /** Something turned up while crossing a forest hex. `hp` is what berries restored. */
  | { t: "forage"; heroId: string; kind: ForageKind; hp?: number }
  /** A hero walked over herbs, mushrooms or a pile of wood or stone and took it. What it gave follows as `resources`. */
  | { t: "pickup"; heroId: string; poiId: string; find: ResourceKind }
  | { t: "xp"; heroId: string; amount: number }
  | { t: "level_up"; heroId: string; level: number }
  | { t: "gold"; heroId: string; amount: number }
  | { t: "loot"; heroId: string; item: ItemDef }
  /** Added by the server, never by `stepWorld`: loot that did not fit in the hero's pack, and where it went instead. */
  | { t: "pack_full"; heroId: string; item: string; place: "storage" | "overfull" }
  | { t: "key_item"; heroId: string; item: string; name: string }
  | { t: "resources"; heroId: string; resources: Resources }
  | { t: "blueprint"; heroId: string; blueprint: string }
  | { t: "furnishing"; heroId: string; furnishing: FurnishingGrant }
  | { t: "geared"; heroId: string }
  | { t: "rite"; heroId: string; text: string }
  | { t: "chat"; line: ChatLine }
  | { t: "npc_intent"; npcId: string; verb: string; ok: boolean; reason?: string }
  | { t: "objective"; id: string }
  | { t: "contract"; heroId: string; contractId: string; met: boolean }
  | { t: "battle_start"; heroes: string[]; enemies: string[] }
  | { t: "battle"; ev: BattleEvent }
  | { t: "battle_end"; status: string }
  | { t: "ended"; outcome: "victory" | "defeat"; reason: string };

export type WorldEffect =
  | { kind: "story_gen" }
  | { kind: "npc_call"; npcId: string; heroId: string; text: string; check: CheckResult | null }
  | { kind: "grant"; heroId: string; xp: number; gold: number; item: ItemDef | null; resources?: Resources; blueprint?: string; furnishing?: FurnishingGrant }
  | { kind: "penalty"; heroId: string; goldPct: number; cap: number }
  | { kind: "epilogue" }
  | { kind: "run_end"; outcome: "victory" | "defeat" };

export type StepResult =
  | { ok: true; state: WorldState; events: WorldEvent[]; effects: WorldEffect[] }
  | { ok: false; error: string };

/** `projects` are the Harbor projects the launching crew has built; their benefits apply when the story begins. */
export function createWorld(code: string, seed: string, projects: readonly string[] = []): WorldState {
  return {
    v: 1,
    code,
    seed,
    rng: seedFromString(`run|${seed}`),
    phase: "lobby",
    hostId: null,
    map: generateMap(seed),
    bible: null,
    heroes: [],
    order: [],
    turnIdx: -1,
    round: 0,
    doom: 0,
    turn: null,
    facts: {},
    npcs: {},
    chat: [],
    battle: null,
    result: null,
    earned: {},
    projects: [...projects],
  };
}

/** Bring a saved state up to the current shape. Call on every state loaded from storage. */
export function upgradeWorld(state: WorldState): WorldState {
  if (state.bible && !state.bible.demand) state.bible.demand = NO_DEMAND;
  if (state.bible && !state.bible.rites) {
    // Stories saved before there was more than one shape of story.
    Object.assign(state.bible, {
      rites: [],
      triggers: [],
      encounters: {},
      route: ["landing", "hut", "lair"],
      victoryLine: `${state.bible.villain.name} is defeated.`,
      defeatLine: `${state.bible.villain.name} slipped away with ${state.bible.relicName}.`,
    });
  }
  // Heroes saved before gear had power and armor.
  for (const hero of state.heroes) {
    hero.weaponPower ??= 0;
    hero.armor ??= 0;
  }
  return state;
}

export function heroStats(hero: Pick<Hero, "base" | "bonus">): Stats {
  return addStats(hero.base, hero.bonus);
}

export function heroPct(hero: Pick<Hero, "base" | "bonus">, stat: StatKey): number {
  return statPct(heroStats(hero)[stat]);
}

/**
 * Identifies the input the game is currently waiting on, or null. The server
 * resets its turn timer whenever this changes.
 */
export function awaitingKey(state: WorldState): string | null {
  if (state.phase === "overworld" && state.turn) return `o:${state.round}:${state.turn.heroId}`;
  if (state.phase === "battle" && state.battle) {
    return `b:${state.battle.round}:${state.battle.turn}:${state.battle.order[state.battle.turn]}`;
  }
  return null;
}

/**
 * Days the doom clock must allow for this party to finish this story on this
 * island: walk the story's route (including any errand for the NPC and the
 * trip back) at the slowest hero's expected pace, with half again for
 * detours and bad rolls, plus days to talk, search, rest and fight.
 */
export function requiredDoom(map: WorldMap, bible: StoryBible, heroes: Pick<Hero, "base" | "bonus">[]): number {
  const stops = bible.route.map((id) => poiById(map, id)).filter((p): p is Poi => !!p);
  let cost = 0;
  for (let i = 1; i < stops.length; i++) cost += findPath(map, stops[i - 1].pos, stops[i].pos)?.cost ?? 0;
  // Movement is 2 plus one per success on four Agility rolls.
  const slowest = Math.min(...heroes.map((h) => 2 + (4 * heroPct(h, "agi")) / 100), 6);
  // A day for each stop where something has to be done, on top of the walking.
  return Math.ceil((cost / slowest) * 1.5) + 2 + Math.ceil(stops.length / 2);
}

// ---------- internals ----------

interface Ctx {
  state: WorldState;
  rng: Rng;
  events: WorldEvent[];
  effects: WorldEffect[];
}

const fail = (error: string): StepResult => ({ ok: false, error });

/** A hero's maximum HP: from stats and level, plus what their hut's hearth adds. */
const heroMaxHp = (hero: Hero) => maxHpFor(heroStats(hero), hero.level) + capPerks(hero.hutPerks).maxHp + capPubBuff(hero.pubBuff).maxHp + brewBuff(hero.brews).maxHp;
const heroById = (state: WorldState, id: string) => state.heroes.find((h) => h.id === id);

function grant(
  ctx: Ctx,
  hero: Hero,
  g: { xp?: number; gold?: number; item?: ItemDef | null; resources?: Resources; blueprint?: string; furnishing?: FurnishingGrant },
) {
  // A furnished hut adds a few percent to every XP award.
  const pubXp = capPubBuff(hero.pubBuff).xpPct;
  const hutXp = xpWithBonus(g.xp ?? 0, hero.hutPerks?.xpPct ?? 0);
  // A meal at the pub adds its own few percent on top.
  const xp = hutXp + Math.round(((g.xp ?? 0) * pubXp) / 100);
  const gold = g.gold ?? 0;
  const item = g.item ?? null;
  const earned = (ctx.state.earned[hero.id] ??= { xp: 0, gold: 0, items: [] });
  earned.xp += xp;
  earned.gold += gold;
  if (item) earned.items.push(item);
  if (xp > 0) {
    ctx.events.push({ t: "xp", heroId: hero.id, amount: xp });
    const next = applyXp({ classId: hero.classId, level: hero.level, xp: hero.xp, stats: hero.base, unspent: hero.unspent }, xp);
    if (next.levelsGained > 0) {
      const oldMax = hero.maxHp;
      hero.base = next.stats;
      hero.level = next.level;
      hero.unspent = next.unspent;
      hero.maxHp = heroMaxHp(hero);
      hero.hp += hero.maxHp - oldMax;
      const focusGain = maxFocusFor(hero.level) - maxFocusFor(hero.level - next.levelsGained);
      hero.maxFocus += focusGain;
      hero.focus += focusGain;
      ctx.events.push({ t: "level_up", heroId: hero.id, level: hero.level });
    }
    hero.xp = next.xp;
  }
  if (gold > 0) ctx.events.push({ t: "gold", heroId: hero.id, amount: gold });
  if (item) ctx.events.push({ t: "loot", heroId: hero.id, item });

  // Things for the hut. Like gear, they are written to the player as they are earned.
  const resources = g.resources && Object.keys(g.resources).length > 0 ? g.resources : undefined;
  if (resources) {
    earned.resources = addResources(earned.resources ?? {}, resources);
    ctx.events.push({ t: "resources", heroId: hero.id, resources });
  }
  if (g.blueprint) {
    (earned.blueprints ??= []).push(g.blueprint);
    ctx.events.push({ t: "blueprint", heroId: hero.id, blueprint: g.blueprint });
  }
  if (g.furnishing) {
    (earned.furnishings ??= []).push(g.furnishing);
    ctx.events.push({ t: "furnishing", heroId: hero.id, furnishing: g.furnishing });
  }
  if (xp > 0 || gold > 0 || item || resources || g.blueprint || g.furnishing) {
    ctx.effects.push({ kind: "grant", heroId: hero.id, xp, gold, item, resources, blueprint: g.blueprint, furnishing: g.furnishing });
  }
}

function setFact(ctx: Ctx, fact: string) {
  if (ctx.state.facts[fact]) return;
  ctx.state.facts[fact] = true;
  const bible = ctx.state.bible;
  if (!bible) return;
  for (const o of bible.objectives) {
    if (o.fact !== fact) continue;
    ctx.events.push({ t: "objective", id: o.id });
    if (o.id === bible.finalObjective) endRun(ctx, "victory", bible.victoryLine);
  }
  // Some places are found by piecing things together rather than by being told.
  for (const trigger of bible.triggers) {
    const poi = poiById(ctx.state.map, trigger.reveal);
    if (poi?.hidden && trigger.requires.every((f) => ctx.state.facts[f])) revealPoi(ctx, poi);
  }
}

function revealPoi(ctx: Ctx, poi: Poi) {
  if (!poi.hidden) return;
  poi.hidden = false;
  ctx.events.push({ t: "poi_revealed", poiId: poi.id });
  setFact(ctx, `revealed:${poi.id}`);
}

/** Settle every hero's notice-board contract, once. Only a won story pays. */
function settleContracts(ctx: Ctx, outcome: "victory" | "defeat") {
  for (const hero of ctx.state.heroes) {
    const taken = hero.contract;
    if (!taken || taken.outcome) continue;
    const def = contractById(taken.id);
    const met = outcome === "victory" && !!def && def.check(ctx.state, hero);
    taken.outcome = met ? "met" : "failed";
    ctx.events.push({ t: "contract", heroId: hero.id, contractId: taken.id, met });
    if (met && def) grant(ctx, hero, def.reward);
  }
}

function endRun(ctx: Ctx, outcome: "victory" | "defeat", reason: string) {
  const { state } = ctx;
  if (state.phase === "ended") return;
  state.phase = "ended";
  state.turn = null;
  state.battle = null;
  state.result = { outcome, reason, epilogue: null };
  for (const hero of state.heroes) {
    if (outcome === "victory") {
      grant(ctx, hero, {
        xp: 50,
        gold: 30,
        item: rollItem(ctx.rng, hero.classId, 0.8, hero.level),
        furnishing: state.bible ? storyTrophy(state.bible) : undefined,
      });
    } else {
      // Soft death: a capped gold loss, never the character.
      ctx.effects.push({ kind: "penalty", heroId: hero.id, goldPct: 0.1, cap: 25 });
    }
  }
  settleContracts(ctx, outcome);
  ctx.events.push({ t: "ended", outcome, reason });
  ctx.effects.push({ kind: "epilogue" }, { kind: "run_end", outcome });
}

const posKeyOf = (p: HexPos) => `${p.q},${p.r}`;

/** Add everything each hero can see from where they stand (and from `also`, the hexes of a walk) to what the party has seen. */
function look(state: WorldState, also: HexPos[] = []) {
  if (!state.seen) return;
  const seen = new Set(state.seen);
  const from = [...state.heroes.map((h) => h.pos), ...also];
  for (const eye of from) {
    const reach = VISION + (tileAt(state.map, eye)?.biome === "hills" ? 1 : 0);
    for (const t of state.map.tiles) if (hexDistance(t, eye) <= reach) seen.add(posKeyOf(t));
  }
  state.seen = [...seen];
}

/** Whether a hero standing at `from` may step onto `tile`: it has been seen, or is in plain sight right now. */
function inSight(state: WorldState, tile: HexPos, from: HexPos): boolean {
  return !state.seen || hexDistance(tile, from) <= VISION || state.seen.includes(posKeyOf(tile));
}

const walkable = (state: WorldState, pos: HexPos) => Number.isFinite(MOVE_COST[tileAt(state.map, pos)?.biome ?? "water"]);

/** Put a new band ashore somewhere out of the heroes' sight, clear of places and other bands. False if there is nowhere. */
function spawnRoamer(ctx: Ctx): boolean {
  const { state, rng } = ctx;
  const roamers = (state.roamers ??= []);
  const open = state.map.tiles.filter(
    (t) =>
      walkable(state, t) &&
      !poiAt(state.map, t) &&
      state.heroes.every((h) => hexDistance(t, h.pos) >= VISION + 2) &&
      state.map.pois.every((p) => p.kind === "pickup" || hexDistance(t, p.pos) >= 2) &&
      roamers.every((r) => hexDistance(t, r.pos) >= 3),
  );
  if (open.length === 0) return false;
  const at = rng.pick(open);
  const lead = rng.pick(["wolf", "bandit"]);
  // A lone hero meets one enemy; a party meets a pair, and a full ship a third.
  const kinds = [lead, ...(state.heroes.length >= 2 ? [lead === "bandit" ? "archer" : "wolf"] : []), ...(state.heroes.length >= 4 ? [lead] : [])];
  state.roamerSeq = (state.roamerSeq ?? 0) + 1;
  roamers.push({ id: `r${state.roamerSeq}`, kinds, pos: { q: at.q, r: at.r } });
  return true;
}

/** A band and a hero have met: the band leaves the map and the fight begins where the hero stands. */
function clash(ctx: Ctx, roamer: Roamer, hero: Hero, by: "band" | "hero") {
  ctx.state.roamers = (ctx.state.roamers ?? []).filter((r) => r.id !== roamer.id);
  ctx.events.push({ t: "ambush", heroId: hero.id, kinds: roamer.kinds, by });
  startBattle(ctx, hero.pos, roamer.kinds, null, null);
}

/**
 * A day has passed: every band moves. One that scents a hero closes two hexes
 * on them; the rest drift a hex, or stay put. The first to come alongside a
 * hero attacks, and the others hold where they are. Now and then a new band
 * comes ashore.
 */
function roam(ctx: Ctx) {
  const { state, rng } = ctx;
  if (!state.roamers || state.phase !== "overworld") return;
  const taken = (pos: HexPos, self: Roamer) => !!poiAt(state.map, pos) || state.roamers!.some((r) => r !== self && r.pos.q === pos.q && r.pos.r === pos.r);
  for (const roamer of [...state.roamers]) {
    const prey = [...state.heroes].filter((h) => h.hp > 0).sort((a, b) => hexDistance(a.pos, roamer.pos) - hexDistance(b.pos, roamer.pos) || a.id.localeCompare(b.id))[0];
    if (!prey) return;
    if (hexDistance(prey.pos, roamer.pos) <= ROAMER_SCENT) {
      const route = findPath(state.map, roamer.pos, prey.pos, 30);
      // A band that starts the night out of the hero's sight comes into view but no closer, so nobody is
      // jumped by something they never had the chance to see. One already in sight comes right up.
      const unseen = hexDistance(prey.pos, roamer.pos) > VISION;
      // Up to two hexes, stopping short of the hero's own hex.
      for (const step of (route?.path ?? []).slice(0, 2)) {
        if ((step.q === prey.pos.q && step.r === prey.pos.r) || taken(step, roamer)) break;
        if (unseen && hexDistance(step, prey.pos) < VISION) break;
        roamer.pos = step;
      }
    } else if (rng.chance(0.6)) {
      const around = state.map.tiles.filter((t) => hexDistance(t, roamer.pos) === 1 && walkable(state, t) && !taken(t, roamer));
      if (around.length > 0) {
        const to = rng.pick(around);
        roamer.pos = { q: to.q, r: to.r };
      }
    }
    if (hexDistance(prey.pos, roamer.pos) <= 1) {
      clash(ctx, roamer, prey, "band");
      return;
    }
  }
  if (state.round % ROAMER_EVERY_DAYS === 0 && state.roamers.length < ROAMERS_MAX) spawnRoamer(ctx);
}

function startTurn(ctx: Ctx) {
  const { state, rng } = ctx;
  for (let i = 0; i < state.order.length; i++) {
    state.turnIdx += 1;
    if (state.turnIdx >= state.order.length) {
      state.turnIdx = 0;
      state.round += 1;
      state.doom -= 1;
      ctx.events.push({ t: "round", round: state.round, doom: state.doom });
      if (state.doom <= 0) {
        endRun(ctx, "defeat", state.bible?.defeatLine ?? "Time ran out.");
        return;
      }
      // Overnight the island's bands move, and one may find the party.
      roam(ctx);
    }
    const hero = heroById(state, state.order[state.turnIdx]);
    if (!hero) continue;
    const check = rollCheck(rng, { label: "Movement", stat: "agi", pct: heroPct(hero, "agi"), count: 4 });
    const mp = 2 + check.successes;
    state.turn = { heroId: hero.id, mp, rolls: check.rolls, acted: false, deadline: null };
    ctx.events.push({ t: "turn_start", heroId: hero.id, mp, check });
    look(state);
    return;
  }
}

/** The hero as they stand right now: the shared combatant, with this voyage's wounds and spent focus. */
function toCombatant(hero: Hero): Combatant {
  return heroCombatant(hero, hero);
}

/**
 * Roll for each forest hex on a walk that nobody has crossed before: wood,
 * berries, old bones, a little buried gold, or wolves. Places with something
 * already on them are left alone. Finds are returned as steps to run once
 * the walk itself has been reported, so the feed reads in order; `ambushAt`
 * is the index of the hex where wolves cut the walk short.
 */
function forage(ctx: Ctx, hero: Hero, path: HexPos[]): { ambushAt: number | null; after: (() => void)[] } {
  const { state, rng } = ctx;
  const seen = (state.forest ??= []);
  const after: (() => void)[] = [];
  for (let i = 0; i < path.length; i++) {
    const pos = path[i];
    const key = `${pos.q},${pos.r}`;
    if (tileAt(state.map, pos)?.biome !== "forest" || seen.includes(key) || poiAt(state.map, pos)) continue;
    seen.push(key);
    let roll = rng.next() * 100;
    const kind = (Object.keys(FORAGE_ODDS) as ForageKind[]).find((k) => (roll -= FORAGE_ODDS[k]) < 0);
    if (!kind) continue;
    if (kind === "wolves") {
      after.push(() => ctx.events.push({ t: "forage", heroId: hero.id, kind }));
      return { ambushAt: i, after };
    }
    if (kind === "berries") {
      after.push(() => {
        const hp = Math.min(hero.maxHp - hero.hp, BERRY_HEAL);
        hero.hp += hp;
        ctx.events.push({ t: "forage", heroId: hero.id, kind, hp });
      });
      continue;
    }
    const amount = kind === "treasure" ? rng.int(8, 20) : rng.int(1, 2);
    after.push(() => {
      ctx.events.push({ t: "forage", heroId: hero.id, kind });
      if (kind === "treasure") grant(ctx, hero, { gold: amount });
      else grant(ctx, hero, { resources: { [kind === "wood" ? "wood" : "bone"]: amount } });
    });
  }
  return { ambushAt: null, after };
}

/** Take whatever lies on the hexes of a walk: one to PICKUP_MAX of it, each pickup once, by whoever gets there first. */
function pickUp(ctx: Ctx, hero: Hero, path: HexPos[]) {
  for (const pos of path) {
    const poi = poiAt(ctx.state.map, pos);
    if (poi?.kind !== "pickup" || poi.cleared || !poi.find) continue;
    poi.cleared = true;
    ctx.events.push({ t: "pickup", heroId: hero.id, poiId: poi.id, find: poi.find });
    grant(ctx, hero, { resources: { [poi.find]: ctx.rng.int(1, PICKUP_MAX) } });
  }
}

function startBattle(ctx: Ctx, at: HexPos, enemies: string[], poiId: string | null, npcId: string | null) {
  const { state } = ctx;
  const fighters = state.heroes.filter((h) => hexDistance(h.pos, at) <= BATTLE_JOIN_RANGE);
  if (fighters.length === 0) return;
  const boss = enemies.some((k) => ENEMIES[k]?.boss);
  const created = createBattle(
    {
      heroes: fighters.map(toCombatant),
      enemyKinds: enemies,
      bossName: boss ? state.bible?.villain.name : undefined,
      avgLevel: fighters.reduce((a, h) => a + h.level, 0) / fighters.length,
      poiId,
    },
    ctx.rng,
  );
  state.phase = "battle";
  state.battle = { ...created.state, npcId, deadline: null };
  ctx.events.push({ t: "battle_start", heroes: fighters.map((h) => h.id), enemies });
  for (const ev of created.events) ctx.events.push({ t: "battle", ev });
  tallyBattle(state.heroes, created.events);
  if (created.state.status !== "active") finishBattle(ctx);
}

function finishBattle(ctx: Ctx) {
  const { state, rng } = ctx;
  const battle = state.battle!;
  const fighters: Hero[] = [];
  for (const c of battle.combatants) {
    if (c.side !== "hero") continue;
    const hero = heroById(state, c.id);
    if (!hero) continue;
    hero.hp = Math.max(1, c.hp);
    hero.focus = c.focus;
    hero.potions = c.potions;
    fighters.push(hero);
  }
  ctx.events.push({ t: "battle_end", status: battle.status });
  state.battle = null;
  const beaten = battle.combatants.filter((c) => c.side === "enemy").map((c) => c.kind);

  if (battle.status === "defeat") {
    endRun(ctx, "defeat", "The party fell in battle.");
    return;
  }
  state.phase = "overworld";
  if (state.turn) state.turn.acted = true;
  if (battle.status !== "victory") return;

  for (const hero of fighters) {
    grant(ctx, hero, {
      xp: battle.xp,
      gold: rng.int(5, 12) * (battle.boss ? 3 : 1),
      item: battle.boss || rng.chance(0.4) ? rollItem(rng, hero.classId, battle.boss ? 0.6 : 0.2, hero.level) : null,
      resources: battleDrops(rng, beaten),
    });
  }
  if (battle.npcId) setFact(ctx, `fought:${battle.npcId}`);
  if (battle.poiId) {
    const poi = poiById(state.map, battle.poiId);
    if (poi) poi.cleared = true;
    setFact(ctx, `defeated:${battle.poiId}`);
  }
}

function pushChat(ctx: Ctx, line: ChatLine) {
  ctx.state.chat.push(line);
  if (ctx.state.chat.length > 60) ctx.state.chat.splice(0, ctx.state.chat.length - 60);
  ctx.events.push({ t: "chat", line });
}

// ---------- action handlers ----------

function interact(ctx: Ctx, hero: Hero): string | null {
  const { state, rng } = ctx;
  const poi = poiAt(state.map, hero.pos);
  if (!poi) return "nothing here";
  const turn = state.turn!;

  // A story step that happens here comes before whatever the place normally offers.
  const rite = state.bible?.rites.find((r) => r.poi === poi.id && !state.facts[r.sets] && r.requires.every((f) => state.facts[f]));
  if (rite) {
    turn.acted = true;
    ctx.events.push({ t: "rite", heroId: hero.id, text: rite.text });
    for (const h of state.heroes) grant(ctx, h, { xp: 20 });
    setFact(ctx, rite.sets);
    return null;
  }

  if (poi.kind === "shrine") {
    if (poi.usedBy.includes(hero.id)) return "the shrine has nothing more for you";
    poi.usedBy.push(hero.id);
    const hp = Math.min(hero.maxHp - hero.hp, 12);
    const focus = hero.maxFocus - hero.focus;
    hero.hp += hp;
    hero.focus = hero.maxFocus;
    ctx.events.push({ t: "rest", heroId: hero.id, hp, focus, where: "shrine" });
    setFact(ctx, `prayed:${poi.id}`);
  } else if (poi.kind === "landing") {
    const hp = Math.min(hero.maxHp - hero.hp, 6);
    hero.hp += hp;
    ctx.events.push({ t: "rest", heroId: hero.id, hp, focus: 0, where: "landing" });
  } else if (poi.kind === "cache") {
    if (poi.cleared) return "already searched";
    poi.cleared = true;
    const check = rollCheck(rng, { label: "Search", stat: "dex", pct: heroPct(hero, "dex"), count: 3 });
    ctx.events.push({ t: "check", heroId: hero.id, check });
    ctx.events.push({ t: "search", heroId: hero.id, found: !check.fumble });
    if (!check.fumble) {
      if (check.successes >= 2) hero.potions += 1;
      grant(ctx, hero, {
        xp: 10,
        gold: rng.int(6, 14) * check.successes,
        item: check.perfect ? rollItem(rng, hero.classId, 0.4, hero.level) : null,
        ...cacheDrops(rng, state.earned[hero.id]?.blueprints),
      });
    }
    // Whatever the story needed from this place is found by anyone who looks, loot or no loot.
    setFact(ctx, `searched:${poi.id}`);
  } else if (poi.kind === "camp" || poi.kind === "lair") {
    if (poi.cleared) return "nothing left to fight here";
    turn.acted = true;
    startBattle(ctx, poi.pos, poi.enemies, poi.id, null);
    return null;
  } else {
    return "nothing to do here";
  }
  turn.acted = true;
  return null;
}

function talk(ctx: Ctx, hero: Hero, action: Extract<WorldAction, { type: "talk" }>): string | null {
  const { state, rng } = ctx;
  const sheet = state.bible?.npcs.find((n) => n.id === action.npcId);
  const run = state.npcs[action.npcId];
  if (!sheet || !run) return "no such character";
  const poi = poiById(state.map, sheet.poi);
  if (!poi || hexDistance(hero.pos, poi.pos) > TALK_RANGE) return "too far away to talk";
  if (run.hostile) return `${sheet.name} will not speak to you`;
  if (run.busy) return `${sheet.name} is still answering`;
  if (run.messages >= MAX_NPC_MESSAGES) return `${sheet.name} has said all they will say`;
  const text = String(action.text ?? "").replace(/\s+/g, " ").trim().slice(0, MAX_PLAYER_TEXT);
  if (!text) return "say something";

  let check: CheckResult | null = null;
  if (action.persuade) {
    const attempts = run.attempts[hero.id] ?? 0;
    if (attempts >= MAX_PERSUADE_ATTEMPTS) return "you have pressed your case as far as it will go";
    const focus = Math.max(0, Math.min(hero.focus, 3, Math.floor(action.focus ?? 0)));
    hero.focus -= focus;
    run.attempts[hero.id] = attempts + 1;
    check = rollCheck(rng, { label: "Persuade", stat: "int_stat", pct: heroPct(hero, "int_stat"), count: 3, focus });
    ctx.events.push({ t: "check", heroId: hero.id, check });
    if (check.successes >= 2) {
      bumpTally(hero, "persuaded");
      run.persuaded = true;
      run.attitude = Math.min(2, run.attitude + 1);
    } else if (check.fumble) {
      run.attitude = Math.max(-2, run.attitude - 1);
    }
  }
  run.messages += 1;
  run.busy = true;
  pushChat(ctx, { npcId: sheet.id, who: "hero", name: hero.name, text });
  setFact(ctx, `met:${sheet.id}`);
  ctx.effects.push({ kind: "npc_call", npcId: sheet.id, heroId: hero.id, text, check });
  return null;
}

function npcReply(ctx: Ctx, action: Extract<WorldAction, { type: "npc_reply" }>): string | null {
  const { state } = ctx;
  const sheet = state.bible?.npcs.find((n) => n.id === action.npcId);
  const run = state.npcs[action.npcId];
  if (!sheet || !run) return "no such character";
  run.busy = false;
  const { say, intent, attitudeDelta } = action.output;
  // Judge the intent against how the NPC felt going into this exchange.
  const verdict = intent ? validateIntent(sheet, run, intent, { demandMet: demandMet(state.bible!, state.facts, run.persuaded) }) : null;
  // Words alone can warm an NPC to 1; only a passed check takes it higher.
  const ceiling = run.persuaded ? 2 : 1;
  run.attitude = Math.max(-2, Math.min(Math.max(run.attitude, ceiling), run.attitude + attitudeDelta));
  pushChat(ctx, { npcId: sheet.id, who: "npc", name: sheet.name, text: say });
  if (!intent || !verdict || state.phase !== "overworld") return null;

  if (!verdict.ok) {
    ctx.events.push({ t: "npc_intent", npcId: sheet.id, verb: intent.verb, ok: false, reason: verdict.reason });
    return null;
  }
  ctx.events.push({ t: "npc_intent", npcId: sheet.id, verb: intent.verb, ok: true });
  const cap = verdict.capability;
  if (!cap) return null;
  run.used.push(cap.id);
  const hero = heroById(state, action.heroId) ?? state.heroes[0];
  const poi = poiById(state.map, sheet.poi)!;

  if (cap.verb === "give_item") {
    const def = KEY_ITEMS[cap.item];
    hero.keyItems.push(cap.item);
    if (def?.grant.maxFocus) {
      hero.maxFocus += def.grant.maxFocus;
      hero.focus += def.grant.maxFocus;
    }
    if (def?.grant.potions) hero.potions += def.grant.potions;
    ctx.events.push({ t: "key_item", heroId: hero.id, item: cap.item, name: cap.itemName });
    pushChat(ctx, { npcId: sheet.id, who: "system", name: "", text: `${hero.name} received ${cap.itemName}.` });
  } else if (cap.verb === "reveal_location") {
    const target = poiById(state.map, cap.poi);
    if (target) {
      revealPoi(ctx, target);
      pushChat(ctx, { npcId: sheet.id, who: "system", name: "", text: `${cap.poiName} is now marked on the map.` });
      for (const h of state.heroes) grant(ctx, h, { xp: 15 });
    }
  } else if (cap.verb === "start_combat") {
    run.hostile = true;
    pushChat(ctx, { npcId: sheet.id, who: "system", name: "", text: `${sheet.name} calls for help. Steel is drawn.` });
    startBattle(ctx, poi.pos, cap.enemies, null, sheet.id);
  }
  return null;
}

function timeout(ctx: Ctx): string | null {
  const { state } = ctx;
  if (state.phase === "overworld" && state.turn) {
    startTurn(ctx);
    return null;
  }
  if (state.phase === "battle" && state.battle) {
    const actor = currentActor(state.battle);
    if (!actor || actor.side !== "hero") return "nothing to time out";
    // An absent player's hero falls back to their first ability.
    return battleAction(ctx, actor.id, { type: "ability", ability: actor.abilities[0] });
  }
  return "nothing to time out";
}

function battleAction(ctx: Ctx, heroId: string, action: BattleAction): string | null {
  const { state } = ctx;
  if (state.phase !== "battle" || !state.battle) return "not in battle";
  const { npcId, deadline, ...battle } = state.battle;
  const res = stepBattle(battle, heroId, action, ctx.rng);
  if (!res.ok) return res.error;
  state.battle = { ...res.state, npcId, deadline };
  for (const ev of res.events) ctx.events.push({ t: "battle", ev });
  tallyBattle(state.heroes, res.events, { heroId, action });
  if (res.state.status !== "active") finishBattle(ctx);
  return null;
}

// ---------- the reducer ----------

export function stepWorld(prev: WorldState, action: WorldAction): StepResult {
  const state = structuredClone(prev);
  const ctx: Ctx = { state, rng: makeRng(state.rng), events: [], effects: [] };
  const done = (error: string | null): StepResult => {
    if (error) return fail(error);
    state.rng = ctx.rng.state();
    return { ok: true, state, events: ctx.events, effects: ctx.effects };
  };

  switch (action.type) {
    case "join": {
      if (heroById(state, action.hero.id)) return done(null);
      if (state.phase !== "lobby") return fail("this ship has already sailed");
      if (state.heroes.length >= MAX_PARTY) return fail("the ship is full");
      // Whatever the caller sends, a hut never gives more than its caps.
      const hut = capPerks(action.hero.hutPerks);
      // Food and drink from the pub count on top, within what the menu can give.
      const pub = capPubBuff(action.hero.pubBuff);
      // And brews from the apothecary: known ones only, one of each.
      const brews = brewBag(action.hero.brews);
      const brew = brewBuff(brews);
      const perks = { focus: hut.focus + pub.focus + brew.focus, potions: hut.potions + pub.potions + brew.potions, maxHp: hut.maxHp + pub.maxHp + brew.maxHp };
      const init: HeroInit = { ...action.hero, hutPerks: hut, pubBuff: pub, brews };
      const rested = freshVitals(init);
      state.heroes.push({
        ...init,
        hp: rested.hp + perks.maxHp,
        maxHp: rested.maxHp + perks.maxHp,
        focus: rested.focus + perks.focus,
        maxFocus: rested.maxFocus + perks.focus,
        potions: rested.potions + perks.potions,
        keyItems: [],
        pos: poiById(state.map, "landing")!.pos,
        ready: false,
      });
      state.hostId ??= init.id;
      ctx.events.push({ t: "joined", heroId: init.id, name: init.name });
      return done(null);
    }

    case "ready": {
      const hero = heroById(state, action.heroId);
      if (!hero) return fail("not aboard");
      if (state.phase !== "lobby") return fail("already under way");
      hero.ready = !!action.ready;
      return done(null);
    }

    case "contract": {
      // Take (or, with null, put back) a notice-board contract. Only before the ship sails.
      const hero = heroById(state, action.heroId);
      if (!hero) return fail("not aboard");
      if (state.phase !== "lobby") return fail("contracts are taken before the ship sails");
      if (action.contractId === null || action.contractId === undefined) {
        delete hero.contract;
        return done(null);
      }
      const def = contractById(String(action.contractId));
      if (!def) return fail("no such contract");
      hero.contract = { id: def.id };
      return done(null);
    }

    case "start": {
      if (state.phase !== "lobby") return fail("already under way");
      if (action.heroId !== state.hostId) return fail("only the captain can set sail");
      if (state.heroes.some((h) => h.id !== state.hostId && !h.ready)) return fail("not everyone is ready");
      state.phase = "generating";
      ctx.events.push({ t: "phase", phase: "generating" });
      ctx.effects.push({ kind: "story_gen" });
      return done(null);
    }

    case "begin": {
      if (state.phase !== "generating") return fail("not waiting for a story");
      const problems = validateBible(action.bible, state.map);
      if (problems.length > 0) return fail(`story rejected: ${problems.join("; ")}`);
      state.bible = action.bible;
      for (const [poiId, enemies] of Object.entries(action.bible.encounters)) {
        const poi = poiById(state.map, poiId);
        if (poi) poi.enemies = enemies;
      }
      // What the crew has built at the Harbor comes along: the lighthouse lengthens the clock.
      const boons = voyageBoons(state.projects);
      state.doom = Math.max(action.bible.doomRounds, requiredDoom(state.map, action.bible, state.heroes)) + boons.doomDays;
      state.npcs = Object.fromEntries(action.bible.npcs.map((n) => [n.id, newNpcRun()]));
      state.order = [...state.heroes]
        .sort((a, b) => heroStats(b).agi - heroStats(a).agi || a.id.localeCompare(b.id))
        .map((h) => h.id);
      state.phase = "overworld";
      state.round = 1;
      // The island starts under fog but for what can be seen from the landing, with a couple of bands already loose on it.
      state.seen = [];
      state.roamers = [];
      look(state);
      for (let i = 0; i < ROAMERS_AT_START; i++) spawnRoamer(ctx);
      ctx.events.push({ t: "phase", phase: "overworld" });
      for (const line of boons.lines) ctx.events.push({ t: "harbor_boon", ...line });
      startTurn(ctx);
      return done(null);
    }

    case "move": {
      if (state.phase !== "overworld" || !state.turn) return fail("you cannot move right now");
      if (state.turn.heroId !== action.heroId) return fail("not your turn");
      const hero = heroById(state, action.heroId)!;
      // Nobody walks into fog: only over ground the party has seen, or can see from here.
      const from = hero.pos;
      const route = findPath(state.map, from, action.to, state.turn.mp, (t) => (inSight(state, t, from) ? MOVE_COST[t.biome] : Infinity));
      if (!route || route.path.length === 0) return fail("out of reach");
      // Walking up to a roaming band starts the fight there, on the hex where they meet.
      const metAt = route.path.findIndex((p) => (state.roamers ?? []).some((r) => hexDistance(r.pos, p) <= 1));
      const band = metAt < 0 ? undefined : (state.roamers ?? []).find((r) => hexDistance(r.pos, route.path[metAt]) <= 1);
      const open = metAt < 0 ? route.path : route.path.slice(0, metAt + 1);
      // The forest may have something in it. Wolves stop the walk where they spring.
      const walk = forage(ctx, hero, open);
      const walked = walk.ambushAt === null ? open : open.slice(0, walk.ambushAt + 1);
      const stopped = walk.ambushAt !== null || band !== undefined;
      state.turn.mp = stopped ? 0 : state.turn.mp - route.cost;
      hero.pos = walked[walked.length - 1];
      ctx.events.push({ t: "moved", heroId: hero.id, path: walked });
      look(state, walked);
      for (const run of walk.after) run();
      pickUp(ctx, hero, walked);
      // Walking past something hidden uncovers it.
      for (const poi of state.map.pois) {
        if (poi.hidden && walked.some((p) => hexDistance(p, poi.pos) <= 1)) revealPoi(ctx, poi);
      }
      if (walk.ambushAt !== null) startBattle(ctx, hero.pos, state.heroes.length >= 3 ? ["wolf", "wolf"] : ["wolf"], null, null);
      else if (band) clash(ctx, band, hero, "hero");
      return done(null);
    }

    case "interact": {
      if (state.phase !== "overworld" || !state.turn) return fail("you cannot act right now");
      if (state.turn.heroId !== action.heroId) return fail("not your turn");
      if (state.turn.acted) return fail("you have already acted this turn");
      return done(interact(ctx, heroById(state, action.heroId)!));
    }

    case "end_turn": {
      if (state.phase !== "overworld" || !state.turn) return fail("no turn to end");
      if (state.turn.heroId !== action.heroId) return fail("not your turn");
      startTurn(ctx);
      return done(null);
    }

    case "timeout":
      return done(timeout(ctx));

    case "talk": {
      if (state.phase !== "overworld") return fail("you cannot talk right now");
      const hero = heroById(state, action.heroId);
      if (!hero) return fail("not aboard");
      return done(talk(ctx, hero, action));
    }

    case "npc_reply":
      return done(npcReply(ctx, action));

    case "battle":
      return done(battleAction(ctx, action.heroId, action.action));

    case "gear": {
      // Server-only: the hero changed what they wear, or spent a stat point, in their inventory. Not during a fight.
      if (state.phase !== "overworld" && state.phase !== "lobby") return fail("you cannot change gear right now");
      const hero = heroById(state, action.heroId);
      if (!hero) return fail("not aboard");
      Object.assign(hero, action.gear);
      hero.maxHp = heroMaxHp(hero);
      // Extra Vitality raises the ceiling but does not heal, or swapping gear back and forth would.
      hero.hp = Math.min(hero.hp, hero.maxHp);
      ctx.events.push({ t: "geared", heroId: hero.id });
      return done(null);
    }

    case "epilogue": {
      if (state.phase !== "ended" || !state.result) return fail("the story is not over");
      state.result.epilogue = String(action.text).trim().slice(0, 1200);
      return done(null);
    }
  }
}
