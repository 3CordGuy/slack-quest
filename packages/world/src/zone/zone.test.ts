import { describe, expect, it } from "vitest";
import { GRID, at, fails, flatBoard, has, must, standEnemy as enemy, standHero, unit } from "../test/zoneBoard";
import { STARTING_STATS, hexDistance, hexNeighbors, posKey, type HexPos } from "@gantt-quest/core";
import { ABILITIES, EFFECT_TICK, ENEMIES, HERO_CLASSES, SUNDERED_DEFENCE, WEAPONS, abilitiesFor } from "../content";
import { CLIMES, type Tile } from "../map";
import { makeRng } from "../rng";
import { abilityArea, checkAbility, courseFor, crateBlow, enemyAct, moveLeft, walk, walkAp, wayBetween } from "./combat";
import { addCondition, attackContext, burnOf, damage, defenceOf, kindle, shieldOf, type Ctx } from "./engine";
import { shantyOf, shantyRadius, songsOn } from "./song";
import { chartOf, constellationLinks } from "./stars";
import { ALERT_RANGE, DEFAULT_ZONE_OPTIONS, JOIN_RANGE, generateZone, zoneOptions } from "./gen";
import { HEX_ROOM, adjacent, blast, blockerAt, flies, isDead, seesFor, solid, stepCost, unitAt, zoneReach } from "./geometry";
import { propOf } from "./props";
import { SITE_IDS, backdropOf, siteInside, type SiteId } from "./sites";
import { ACTION_AP, AP_MAX, AP_TURN, AQUEOUS, RALLY, SUMMON_AP_TURN, AURAS, CHART, COMMON_ACTIONS, BLOCK, BONUS_AP, BOLSTER, AGAINST_WAVES, ENDURE, STAND_STRONG, STURDY, ENEMY_BURST, ENEMY_HP_SCALE, ENEMY_KIT, ENEMY_MOVE_AP, EXPLORE_ROUND_MS, FLEE_RANGE, LIGHT_RADIUS, SHIELD_SET_ASIDE, TACTICS, TORCH_GROUND_ROUNDS, TORCH_HELD_ROUNDS, TORCH_ROUND_MS, abilityDice as abilityDiceFor, commonCost, enemyHp, enemyMove, enemyStrikes, tacticOf } from "./kit";
import { MAX_CATCHUP_ROUNDS } from "./clock";
import { d20, diceAverage, diceFor, heroMove, hitChance } from "./rules";
import { createZone, ensureMouth, spentOut, standInHero, stepZone, zoneView } from "./zone";
import { DELVE_CRATES, DELVE_GLOWCAPS as GLOWCAP_COUNT, generateDelve } from "./delve";
import { litHexes } from "./light";
import { poolFor } from "../classabilities";
import { DEFAULT_APPEARANCE } from "../appearance";
import { GARB_HAT, LANTERN_HELM_ICON, type Outfit } from "../gear";
import { CHEST_PAY, unopened } from "./loot";
import { CRATE_HP, CRATE_PAY } from "./crates";
import { NOISE_RANGE } from "./doors";
import { GLOWCAP_MUSHROOMS } from "./forage";
import type { SurfaceKind, Unit, ZoneAction, ZoneEffect, ZoneEvent, ZoneState } from "./types";

// ---------- helpers ----------

/** A Diving Helm on the head: a Paladin in it has no lantern helm to light the dark. */
const IN_A_DIVING_HELM: Outfit = { helmet: { icon: "heavy-helm", ref: "hardhat", rarity: "common" } };
/** The Lighthouse Paladin's starter hat on the head: the lantern helm. */
const IN_THE_LANTERN_HELM: Outfit = { helmet: { icon: LANTERN_HELM_ICON, ref: GARB_HAT, rarity: "common" } };
/** Any other class's starter hat: a plain knitted cap. */
const IN_A_KNIT_CAP: Outfit = { helmet: { icon: "knit-cap", ref: GARB_HAT, rarity: "common" } };

/** A flat, open board with nothing on it. */
const board = (edit: (tile: Tile) => void = () => {}): ZoneState => flatBoard({ rng: 12345, start: at(2, 6), options: { party: 1 }, flags: { shareTurns: true }, edit });
const tileEdit = (pos: HexPos, change: Partial<Tile>) => (t: Tile) => { if (t.q === pos.q && t.r === pos.r) Object.assign(t, change); };

const hero = (state: ZoneState, id: string, classId: string, pos: HexPos): Unit =>
  standHero(state, id, pos, {
    classId, level: 1, armor: 2, power: 1,
    abilities: classId === "refactor_rogue" ? ["bow_shot", "stab"] : classId === "devops_mage" ? ["shock", "mend"] : ["bash", "block"],
    items: { healing: 2, poison: 2, fire: 1, oil: 1, water: 1 },
  });
const zoneBlastCount = (state: ZoneState, pos: HexPos) => blast(state.map, pos, 1).length;
const paint = (state: ZoneState, kind: SurfaceKind | null, hexes: HexPos[]) => must(state, { type: "dev", by: "dev", dev: { op: "paint", kind, hexes } });
/** Set the nearest group on a hero where they stand, without anyone having to walk up to anyone. */
const provoke = (state: ZoneState, by = "ann", sink: ZoneEvent[] = []) => must(state, { type: "dev", by, dev: { op: "start_fight" } }, sink);
/** Put a hero in a fight with one enemy, with the enemy AI off, and it is the hero's turn. */
function duel(kind = "bandit", classId = "qa_paladin", heroAt = at(5, 6), enemyAt = at(8, 6)) {
  let state = board();
  state.aiOff = true;
  hero(state, "ann", classId, heroAt);
  const foe = enemy(state, kind, enemyAt);
  // A step toward it, and the fight is on (by walking up to it, if that step did; set on them, if not).
  state = must(state, { type: "move", by: "ann", unit: "ann", to: { q: heroAt.q + 1, r: heroAt.r } });
  if (!state.encounter) state = provoke(state);
  // The enemy's turn (if it won initiative) passes with the AI off.
  expect(state.encounter?.acting).toEqual(["ann"]);
  return { state, foe: foe.id };
}

/** Ann uses an ability, at a target or a hex if it takes one. */
const use = (ability: string, aim: { target?: string; at?: HexPos } = {}): ZoneAction => ({ type: "use", by: "ann", unit: "ann", ability, ...aim });
/** Everyone sharing ann's turn ends it (conditions run down as a shared turn ends, not as each one in it does). A stand-in or a summon is ended by whoever plays it. */
function endShared(state: ZoneState, sink: ZoneEvent[] = []): ZoneState {
  for (const id of [...state.encounter!.acting]) if (!state.encounter!.done.includes(id) && !unit(state, id).down) state = must(state, { type: "end_turn", by: unit(state, id).controller ?? id, unit: id }, sink);
  return state;
}
/** On to ann's next turn. */
function nextTurn(state: ZoneState, sink: ZoneEvent[] = []): ZoneState {
  state = endShared(state, sink);
  while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" }, sink);
  return state;
}
/** The action tried on fresh seeds until it hits `target` and `want` holds: the state after, and what it said. */
const untilHit = (state: ZoneState, action: ZoneAction, target: string, want: (events: ZoneEvent[]) => boolean = () => true) => {
  for (let seed = 1; seed < 120; seed++) {
    const tryState = structuredClone(state);
    tryState.rng = seed;
    const events: ZoneEvent[] = [];
    const next = must(tryState, action, events);
    if (events.some((e) => e.t === "hit" && e.target === target) && want(events)) return { state: next, events };
  }
  throw new Error("never landed");
};
const failedSave = (events: ZoneEvent[]) => events.some((e) => e.t === "roll" && e.roll.kind === "save" && !e.roll.ok);
const savedAll = (events: ZoneEvent[]) => events.some((e) => e.t === "roll" && e.roll.kind === "save") && !failedSave(events);

// ---------- the dice ----------

describe("dice", () => {
  it("turns an old damage number into dice that average about the same", () => {
    for (const amount of [2, 4, 5, 6, 7, 9, 12, 13]) expect(Math.abs(diceAverage(diceFor(amount)) - amount)).toBeLessThanOrEqual(0.75);
  });

  it("keeps the better of two with advantage and the worse with disadvantage", () => {
    for (let seed = 1; seed < 40; seed++) {
      const up = d20(makeRng(seed), { kind: "attack", id: "a", label: "", bonus: 0, vs: 10, adv: 1 });
      const down = d20(makeRng(seed), { kind: "attack", id: "a", label: "", bonus: 0, vs: 10, adv: -1 });
      expect(up.kept).toBe(Math.max(...up.d20));
      expect(down.kept).toBe(Math.min(...down.d20));
      expect(up.d20).toEqual(down.d20);
    }
  });

  it("always hits on a natural 20 and never on a natural 1", () => {
    expect(hitChance(-10, 30, 0)).toBeCloseTo(0.05);
    expect(hitChance(30, 5, 0)).toBeCloseTo(0.95);
    expect(hitChance(5, 15, 1)).toBeGreaterThan(hitChance(5, 15, 0));
    expect(hitChance(5, 15, -1)).toBeLessThan(hitChance(5, 15, 0));
  });

  it("gives a hero 2 to 4 steps for each AP by Agility", () => {
    expect(heroMove({ ...STARTING_STATS.qa_paladin, agi: 1 })).toBe(2);
    expect(heroMove({ ...STARTING_STATS.qa_paladin, agi: 5 })).toBe(2);
    expect(heroMove({ ...STARTING_STATS.qa_paladin, agi: 11 })).toBe(3);
    expect(heroMove({ ...STARTING_STATS.qa_paladin, agi: 30 })).toBe(4);
  });
});

// ---------- the kit ----------

describe("the kit", () => {
  it("has a tactical entry for every ability", () => {
    for (const id of Object.keys(ABILITIES)) expect(TACTICS[id], id).toBeDefined();
    for (const id of Object.keys(TACTICS)) expect(ABILITIES[id], id).toBeDefined();
  });

  it("has an entry for every enemy, naming only attacks that enemy has", () => {
    for (const kind of Object.keys(ENEMIES)) {
      expect(ENEMY_KIT[kind], kind).toBeDefined();
      for (const name of Object.keys(ENEMY_KIT[kind].attacks ?? {})) expect(ENEMIES[kind].attacks.some((a) => a.name === name), `${kind}: ${name}`).toBe(true);
      expect(enemyStrikes(kind, 1).length).toBe(ENEMIES[kind].attacks.length);
    }
  });

  it("gives melee abilities a reach of one hex and everything else a range", () => {
    for (const [id, t] of Object.entries(TACTICS)) {
      if (t.reach === "melee") expect(t.range, id).toBe(1);
      else if (t.shape !== "self" && t.shape !== "burst") expect(t.range, id).toBeGreaterThan(1);
    }
  });
});

// ---------- generation ----------

describe("zone generation", () => {
  it("makes the same map from the same seed and options", () => {
    const a = generateZone("seed-1", DEFAULT_ZONE_OPTIONS);
    const b = generateZone("seed-1", DEFAULT_ZONE_OPTIONS);
    expect(a).toEqual(b);
    expect(generateZone("seed-2", DEFAULT_ZONE_OPTIONS)).not.toEqual(a);
  });

  it("keeps the start clear and level, posts every band well away from it, and leaves a way on foot to every post and beside every chest", () => {
    let laid = 0;
    let under = 0;
    for (const biome of ["meadow", "woods", "caves", "shore"] as const) {
      for (const size of ["small", "medium", "large"] as const) {
        for (let seed = 0; seed < 6; seed++) {
          // Half of them whatever kind of place suits the ground, the rest each kind in turn; and every climate comes round.
          const site = biome === "caves" || seed < 3 ? undefined : SITE_IDS[laid++ % SITE_IDS.length];
          const clime = CLIMES[(seed + (size === "small" ? 0 : size === "medium" ? 1 : 2)) % CLIMES.length];
          const options = zoneOptions({ size, biome, groups: 3, elevation: 3, obstacles: 3, clear: 4, party: 2, site, clime });
          const where = `${biome} ${size} ${seed} ${site ?? ""} ${clime}`;
          const state = createZone("GEN", `${biome}-${size}-${seed}`, options);
          // The same seed and options: the same map, and the same bands at the same posts.
          expect(createZone("GEN", `${biome}-${size}-${seed}`, options), where).toEqual(state);
          const tiles = new Map(state.map.tiles.map((t) => [posKey(t), t]));
          // No hex is laid twice.
          expect(tiles.size, where).toBe(state.map.tiles.length);
          const foes = state.units.filter((u) => u.side === "enemy");
          expect(foes.length, where).toBeGreaterThan(0);
          // Under a roof or under ground (indoors.ts) the party arrives in a room of its own, and what keeps the bands off is its walls.
          const indoors = !!state.scene && siteInside(state.scene.site);
          if (indoors) under++;
          for (const f of foes) expect(hexDistance(f.pos, state.start), where).toBeGreaterThan(indoors ? 3 : options.clear + ALERT_RANGE);
          // Each at a post of its own, on ground it can stand on.
          expect(new Set(foes.map((f) => posKey(f.pos))).size, where).toBe(foes.length);
          for (const f of foes) expect(solid(tiles.get(posKey(f.pos))), `${where}: ${f.kind} in the ground`).toBe(false);
          expect(solid(tiles.get(posKey(state.start))), where).toBe(false);
          if (biome === "caves") {
            // Open cave floor is made the old way: open, level ground all round the start (the map's own edge aside), and no scene.
            for (const t of state.map.tiles) if (hexDistance(t, state.start) <= options.clear && hexNeighbors(t, state.map.grid).length === 6) expect(solid(t) || (t.elev ?? 0) !== 0, where).toBe(false);
            expect(state.scene, where).toBeUndefined();
          } else {
            if (!indoors) {
              // Round the start, what land there is lies level and open: nothing stands on it but the ring the party came through, beside them.
              const round = state.map.tiles.filter((t) => hexDistance(t, state.start) <= options.clear);
              for (const t of round) {
                expect(t.elev ?? 0, where).toBe(0);
                if (t.prop) expect([t.prop, hexDistance(t, state.start)], where).toEqual(["waygate", 1]);
                else expect(solid(t), where).toBe(false);
              }
              // And there is a fair stretch of it: as much as two hexes all round would be, at the least.
              expect(round.filter((t) => !solid(t)).length, where).toBeGreaterThanOrEqual(19);
            } else {
              // Indoors the room's own walls are near, so it is a smaller stretch. The party stands on floor with floor all
              // round them: nothing on it but the ring they came through, beside them.
              const beside = state.map.tiles.filter((t) => hexDistance(t, state.start) <= 1);
              expect(beside, where).toHaveLength(7);
              for (const t of beside) {
                if (t.prop) expect([t.prop, hexDistance(t, state.start)], where).toEqual(["waygate", 1]);
                else expect(solid(t), where).toBe(false);
              }
              expect(beside.filter((t) => t.prop === "waygate"), where).toHaveLength(1);
              // Two hexes out, what is not floor is the wall of the room (or a doorway in it), or the rock of the chamber:
              // nothing else stands there to bar the way, and the floor is level.
              const round = state.map.tiles.filter((t) => hexDistance(t, state.start) <= 2);
              for (const t of round) {
                if (t.biome === "rock") continue;
                expect(t.elev ?? 0, where).toBe(0);
                if (t.prop && t.prop !== "waygate") expect(["wall", "wall_torch", "arch"], `${where}: ${t.prop}`).toContain(t.prop);
              }
              // And most of that is floor to stand on.
              expect(round.filter((t) => !solid(t)).length, where).toBeGreaterThanOrEqual(13);
              // Nothing lies beyond the walls, and it is dark.
              expect(state.scene!.backdrop, where).toBe("dark");
            }
            // It says what kind of place it is, and what lies round its land (on a shore, the sea).
            expect(state.scene, where).toEqual({ site: site ?? state.scene!.site, backdrop: backdropOf(state.scene!.site as SiteId, options.clime, options.biome) });
            expect(SITE_IDS, where).toContain(state.scene!.site);
          }
          // A hero alone on the map can walk from the start to every post, by the rules of the walk: no cliff climbed without a ladder.
          const walker = hero(state, "ann", "qa_paladin", state.start);
          const reach = zoneReach({ ...state, units: [walker] }, walker, 5000);
          for (const f of foes) expect(reach.has(posKey(f.pos)), `${where}: ${f.kind} cut off`).toBe(true);
          // And to a hex beside every chest. Nothing stands where a chest or a post is.
          const chests = state.map.pois.filter((p) => p.kind === "cache");
          for (const c of chests) {
            expect(solid(tiles.get(posKey(c.pos))), `${where}: ${c.id} in the ground`).toBe(false);
            expect(foes.some((f) => posKey(f.pos) === posKey(c.pos)), `${where}: ${c.id} stood on`).toBe(false);
            expect(hexNeighbors(c.pos, state.map.grid).some((n) => reach.get(posKey(n))?.stop), `${where}: ${c.id} cut off`).toBe(true);
          }
          for (const p of [...foes.map((f) => f.pos), ...chests.map((c) => c.pos)]) expect(propOf(tiles.get(posKey(p)))?.blocks, where).toBeFalsy();
        }
      }
    }
    // Every kind of place there is was laid at least once: the four under a roof or under ground among them.
    expect(laid).toBeGreaterThanOrEqual(SITE_IDS.length);
    expect(under).toBeGreaterThanOrEqual(SITE_IDS.filter(siteInside).length);
  }, 60_000);

  it("makes options safe", () => {
    expect(zoneOptions({ size: "huge", groups: 99, kinds: ["wolf", "dragon"], clear: -3 })).toEqual({ ...DEFAULT_ZONE_OPTIONS, groups: 8, kinds: ["wolf"], clear: 2 });
    expect(zoneOptions(null)).toEqual(DEFAULT_ZONE_OPTIONS);
    // The kind of place: one there is, or none. How much the lodestone that opened it carried: 0 to 3.
    expect(zoneOptions({ site: "keep", stone: 7 })).toEqual({ ...DEFAULT_ZONE_OPTIONS, site: "keep", stone: 3 });
    expect(zoneOptions({ site: "nowhere", stone: "two" })).toEqual(DEFAULT_ZONE_OPTIONS);
    expect(zoneOptions({ stone: -2 }).stone).toBe(0);
    expect(zoneOptions({ stone: 1.6 }).stone).toBe(2);
  });
});

// ---------- walking, and walking into a fight ----------

describe("free walking", () => {
  it("lets a hero walk anywhere with no fight on, and takes no turns", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(2, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(12, 3) }, events);
    expect(unit(state, "ann").pos).toEqual(at(12, 3));
    expect(state.encounter).toBeNull();
    expect(events.filter((e) => e.t === "moved")).toHaveLength(1);
  });

  it("refuses rock, water, cliffs, a hex with no room left on it, and somebody else's hero", () => {
    let state = board((t) => { tileEdit(at(4, 6), { biome: "rock" })(t); tileEdit(at(4, 8), { biome: "water" })(t); tileEdit(at(2, 3), { elev: 2 })(t); });
    hero(state, "ann", "qa_paladin", at(2, 6));
    hero(state, "bo", "qa_paladin", at(2, 7));
    hero(state, "cy", "qa_paladin", at(2, 7));
    hero(state, "di", "qa_paladin", at(3, 7));
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(4, 6) })).toMatch(/cannot get there/);
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(4, 8) })).toMatch(/cannot get there/);
    // A lone hex two levels up is a cliff on every side.
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(2, 3) })).toMatch(/cannot get there/);
    // Two stand on that hex already: it is full.
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(2, 7) })).toMatch(/standing there/);
    expect(fails(state, { type: "move", by: "ann", unit: "bo", to: at(3, 8) })).toMatch(/not yours/);
    // One hero on a hex leaves room for another beside them on it.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(3, 7) });
    expect(unit(state, "ann").pos).toEqual(at(3, 7));
    expect(unit(state, "di").pos).toEqual(at(3, 7));
  });
});

describe("starting a fight", () => {
  it("starts when a hero runs right up to an enemy, and not before", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(1, 6));
    const wolf = enemy(state, "wolf", at(10, 6));
    const mate = enemy(state, "wolf", at(11, 6));
    // Two hexes off, in plain sight: nothing.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 6) });
    expect(state.encounter).toBeNull();
    expect(unit(state, "ann").pos).toEqual(at(8, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(9, 6) }, events);
    expect(hexDistance(unit(state, "ann").pos, wolf.pos)).toBe(ALERT_RANGE);
    expect(state.encounter).not.toBeNull();
    expect(new Set(state.encounter!.order)).toEqual(new Set(["ann", wolf.id, mate.id]));
    expect(state.groups.g1.alerted).toBe(true);
    expect(events.some((e) => e.t === "fight_start")).toBe(true);
    // Each of the three rolls initiative once; any roll besides is two of them rolling off a tie.
    const rolls = events.flatMap((e) => (e.t === "roll" && e.roll.kind === "initiative" ? [e.roll] : []));
    expect(rolls.filter((r) => r.label === "Initiative").map((r) => r.id).sort()).toEqual(["ann", wolf.id, mate.id].sort());
    expect(rolls.every((r) => r.label === "Initiative" || r.label === "Tie-break")).toBe(true);
    // Nobody shares a place in the order.
    const places = state.encounter!.order.map((id) => `${state.encounter!.init[id]}/${state.encounter!.tie?.[id] ?? 0}`);
    expect(new Set(places).size).toBe(3);
  });

  it("stops a hero who walks past an enemy on the first hex beside it", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    const wolf = enemy(state, "wolf", at(7, 5));
    // The straight way to the far side runs right under its nose.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(12, 6) });
    expect(state.encounter).not.toBeNull();
    expect(hexDistance(unit(state, "ann").pos, wolf.pos)).toBe(1);
    expect(unit(state, "ann").pos).not.toEqual(at(12, 6));
  });

  it("leaves a hero far away free to walk, and pulls them in when they come near", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(5, 2));
    hero(state, "bo", "qa_paladin", at(1, 10));
    enemy(state, "wolf", at(7, 2));
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 2) });
    expect(state.encounter!.order).not.toContain("bo");
    // Bo is in no fight: no turn to wait for, and the walk costs nothing.
    state = must(state, { type: "move", by: "bo", unit: "bo", to: at(1, 8) });
    expect(unit(state, "bo").pos).toEqual(at(1, 8));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "bo", unit: "bo", to: at(6, 3) }, events);
    expect(state.encounter!.order).toContain("bo");
    expect(events.some((e) => e.t === "fight_join" && e.id === "bo")).toBe(true);
    // Stopped where they came into range, short of where they were going.
    expect(Math.min(...state.units.filter((u) => u.id !== "bo" && state.encounter!.order.includes(u.id)).map((u) => hexDistance(u.pos, unit(state, "bo").pos)))).toBe(JOIN_RANGE);
  });

  it("pulls a second group in when a fighter comes within its sight", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "refactor_rogue", at(4, 2));
    enemy(state, "wolf", at(6, 2), "g1");
    const far = enemy(state, "bandit", at(4, 4), "g2");
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 2) });
    expect(state.encounter!.order).not.toContain(far.id);
    while (state.encounter!.acting[0] !== "ann") state = must(state, { type: "timeout" });
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(4, 3) });
    expect(state.groups.g2.alerted).toBe(true);
    expect(state.encounter!.order).toContain(far.id);
  });
});

// ---------- turns ----------

describe("turns", () => {
  /** Ann and Bo in a fight with a dummy, on the initiatives given, with the dummy's turn just over: the round comes round to them. */
  function rolled(init: { ann: number; bo: number }, share = true) {
    let state = board();
    state.aiOff = true;
    // Whether heroes side by side in the order take a turn together is the tests' own switch: in play nobody does.
    state.shareTurns = share;
    hero(state, "ann", "qa_paladin", at(5, 6));
    hero(state, "bo", "qa_paladin", at(5, 7));
    const dummy = enemy(state, "dummy", at(9, 6));
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }));
    Object.assign(state.encounter!, { order: ["ann", "bo", dummy.id], init: { ...init, [dummy.id]: 1 }, acting: [dummy.id], done: [dummy.id], budgets: {} });
    return must(state, { type: "timeout" });
  }

  it("under the tests' switch for shared turns, gives heroes side by side in the order one shared turn", () => {
    let state = rolled({ ann: 15, bo: 15 });
    expect(new Set(state.encounter!.acting)).toEqual(new Set(["ann", "bo"]));
    // Either can go first, and the turn passes only when both have ended theirs.
    state = must(state, { type: "end_turn", by: "bo", unit: "bo" });
    expect(state.encounter!.acting).toContain("ann");
    expect(fails(state, { type: "end_turn", by: "bo", unit: "bo" })).toMatch(/not your turn/);
    const turn = state.encounter!.turnNo;
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    expect(state.encounter!.turnNo).toBeGreaterThan(turn);
  });

  it("spends AP on anything, in any order, and refuses what it cannot pay for", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(5, 6), at(8, 6));
    const budget = () => state.encounter!.budgets.ann;
    expect(budget()).toMatchObject({ ap: AP_TURN, move: 0 });
    const stride = budget().stride;
    expect(stride).toBe(heroMove(unit(state, "ann").stats!));
    // A step buys a stride of movement for 1 AP, and what is left of it is spent before another AP is.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) });
    expect(budget()).toMatchObject({ ap: AP_TURN - 1, move: stride - 1 });
    // An attack (once an Action) is 2 AP; another is 2 more.
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe });
    expect(budget().ap).toBe(AP_TURN - 1 - ACTION_AP);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe })).toMatch(/takes 2 AP, and you have 1 left/);
    // Block (once a Bonus action) is 1.
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "block" });
    expect(budget().ap).toBe(0);
    expect(shieldOf(unit(state, "ann"))).toBeGreaterThan(0);
    expect(fails(state, { type: "drink", by: "ann", unit: "ann", item: "healing" })).toMatch(/takes 1 AP/);
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(1, 1) })).toMatch(/AP you have left/);
  });

  it("carries AP left at the end of a turn into the next, to 6 at most", () => {
    let { state } = duel("dummy", "qa_paladin", at(5, 6), at(8, 6));
    const ann = () => state.encounter!.budgets.ann;
    const nextTurn = (s: ZoneState) => {
      s = must(s, { type: "end_turn", by: "ann", unit: "ann" });
      while (!s.encounter!.acting.includes("ann") || s.encounter!.done.includes("ann")) s = must(s, { type: "timeout" });
      return s;
    };
    expect(ann().ap).toBe(AP_TURN);
    state = nextTurn(state);
    expect(ann().ap).toBe(AP_MAX);
    state = nextTurn(state);
    expect(ann().ap).toBe(AP_MAX);
    // Movement bought and not walked is not kept.
    state.encounter!.budgets.ann.stride = 3;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(4, 6) });
    expect(ann().move).toBeGreaterThan(0);
    state = nextTurn(state);
    expect(ann()).toMatchObject({ ap: AP_MAX, move: 0 });
  });

  it("ends a turn on its own once the last AP is spent, after what spent it has played out", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(5, 6), at(7, 6));
    const turn = state.encounter!.turnNo;
    Object.assign(state.encounter!.budgets.ann, { ap: ACTION_AP + BONUS_AP, move: 0 });
    expect(spentOut(state.encounter!.budgets.ann)).toBe(false);
    // AP still left: the turn goes on.
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "block" });
    expect(state.encounter).toMatchObject({ turnNo: turn, acting: ["ann"], done: [] });
    // The last of them: the blow lands, then the dummy has its turn, and it is hers again with a fresh turn's worth (none were left to keep).
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe }, events);
    const turnAt = events.findIndex((e) => e.t === "turn");
    expect(turnAt).toBeGreaterThan(0);
    const usedAt = events.findIndex((e) => e.t === "used" && e.what === "bash");
    expect(usedAt).toBeGreaterThanOrEqual(0);
    expect(usedAt).toBeLessThan(turnAt);
    expect(state.encounter!.turnNo).toBeGreaterThan(turn);
    expect(state.encounter!.acting).toEqual(["ann"]);
    expect(state.encounter!.budgets.ann.ap).toBe(AP_TURN);
    // Spent out is no AP left and nothing bought with them left to walk, a course charted included.
    expect(spentOut({ ap: 0, move: 0, stride: 2, disengaged: false })).toBe(true);
    expect(spentOut({ ap: 0, move: 1, stride: 2, disengaged: false })).toBe(false);
    expect(spentOut({ ap: 0, move: 0, stride: 2, disengaged: false, course: 1 })).toBe(false);
    expect(spentOut({ ap: 1, move: 0, stride: 2, disengaged: false })).toBe(false);
  });

  it("keeps a spent-out turn going while movement bought with the last AP is left to walk", () => {
    let { state } = duel("dummy", "qa_paladin", at(5, 6), at(8, 6));
    const turn = state.encounter!.turnNo;
    Object.assign(state.encounter!.budgets.ann, { ap: 1, move: 0, stride: 3 });
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) });
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: 0, move: 2 });
    expect(state.encounter).toMatchObject({ turnNo: turn, done: [] });
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(3, 6) });
    expect(state.encounter!.turnNo).toBeGreaterThan(turn);
  });

  it("ends only the spent-out hero's part of a turn two are taking together (the tests' switch for shared turns)", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    hero(state, "bo", "qa_paladin", at(3, 8));
    enemy(state, "wolf", at(9, 6));
    state = provoke(state);
    const fresh = () => ({ ap: AP_TURN, move: 0, stride: 2, disengaged: false });
    Object.assign(state.encounter!, { acting: ["ann", "bo"], done: [], budgets: { ann: { ...fresh(), ap: BONUS_AP }, bo: fresh() } });
    const turn = state.encounter!.turnNo;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "block" });
    expect(state.encounter).toMatchObject({ turnNo: turn, acting: ["ann", "bo"], done: ["ann"] });
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "block" })).toMatch(/not your turn/);
    state = must(state, { type: "end_turn", by: "bo", unit: "bo" });
    expect(state.encounter!.turnNo).toBeGreaterThan(turn);
  });

  it("charges 2 for forest and 1 more to climb, buying a stride at a time", () => {
    let state = board((t) => { tileEdit(at(7, 6), { biome: "forest" })(t); tileEdit(at(6, 5), { elev: 1 })(t); });
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(5, 6));
    enemy(state, "dummy", at(9, 6));
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }));
    const budget = () => state.encounter!.budgets.ann;
    budget().stride = 2;
    expect(budget()).toMatchObject({ ap: AP_TURN, move: 0 });
    // Into the forest: 2, a stride's worth.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) });
    expect(budget()).toMatchObject({ ap: AP_TURN - 1, move: 0 });
    // One step back and up, onto open ground a level up: 1 + 1, another AP.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 5) });
    expect(budget()).toMatchObject({ ap: AP_TURN - 2, move: 0 });
    expect(COMMON_ACTIONS).not.toHaveProperty("dash");
  });

  it("ends the turn when its timer runs out", () => {
    let { state } = duel("dummy");
    const turn = state.encounter!.turnNo;
    state = must(state, { type: "timeout" });
    expect(state.encounter!.turnNo).toBeGreaterThan(turn);
  });
});

// ---------- attacks ----------

describe("attacks", () => {
  it("needs a melee target adjacent, and a ranged one in range with a clear line", () => {
    let state = board((t) => tileEdit(at(7, 6), { biome: "rock" })(t));
    state.aiOff = true;
    hero(state, "ann", "refactor_rogue", at(4, 6));
    const foe = enemy(state, "dummy", at(9, 6));
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }));
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "stab", target: foe.id })).toMatch(/next to it/);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "bow_shot", target: foe.id })).toMatch(/clear line/);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 5) });
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bow_shot", target: foe.id }, events);
    const roll = events.find((e) => e.t === "roll" && e.roll.kind === "attack");
    expect(roll).toBeDefined();
    expect(events.some((e) => e.t === "hit" || e.t === "miss")).toBe(true);
  });

  it("gives advantage and disadvantage for the reasons it says, and they cancel", () => {
    const state = board((t) => { tileEdit(at(5, 5), { elev: 1 })(t); tileEdit(at(9, 5), { biome: "forest" })(t); });
    const ann = hero(state, "ann", "refactor_rogue", at(5, 6));
    const foe = enemy(state, "bandit", at(9, 6));
    const far = { melee: false };
    expect(attackContext(state, ann, foe, far)).toMatchObject({ adv: 0, mods: 0 });
    foe.conditions = [{ kind: "exposed", rounds: 2 }];
    expect(attackContext(state, ann, foe, far).adv).toBe(1);
    ann.conditions = [{ kind: "poisoned", rounds: 2 }];
    expect(attackContext(state, ann, foe, far).adv).toBe(0);
    foe.conditions = [];
    expect(attackContext(state, ann, foe, far).adv).toBe(-1);
    ann.conditions = [];
    // Focus is advantage; so is a Prone target, but only up close.
    expect(attackContext(state, ann, foe, { melee: false, focus: true }).adv).toBe(1);
    foe.conditions = [{ kind: "prone", rounds: 1 }];
    expect(attackContext(state, ann, foe, { melee: true }).adv).toBe(1);
    expect(attackContext(state, ann, foe, far).adv).toBe(-1);
    foe.conditions = [];
    // High ground, and a target among trees.
    expect(attackContext(state, { ...ann, pos: at(5, 5) }, foe, far).mods).toBe(2);
    expect(attackContext(state, ann, { ...foe, pos: at(9, 5) }, far).mods).toBe(-2);
    expect(attackContext(state, ann, { ...foe, pos: at(9, 5) }, { melee: true }).mods).toBe(0);
  });

  it("makes shooting with an enemy beside you harder", () => {
    const { state, foe } = duel("dummy", "refactor_rogue", at(5, 6), at(8, 6));
    const ann = unit(state, "ann");
    expect(attackContext(state, ann, unit(state, foe), { melee: false }).adv).toBe(0);
    expect(attackContext(state, { ...ann, pos: at(7, 6) }, unit(state, foe), { melee: false }).adv).toBe(-1);
  });

  it("puts an ability with a cooldown out of use for that many turns, the one it was used in counted as it ends", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(6, 6), at(8, 6));
    unit(state, "ann").abilities = ["stoke_the_fire"];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "stoke_the_fire" });
    const wait = tacticOf("stoke_the_fire").cooldown!;
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "stoke_the_fire" }), "the same turn").toMatch(/not ready/);
    for (let turn = 1; turn < wait; turn++) {
      state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
      expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "stoke_the_fire" }), `turn ${turn}`).toMatch(/not ready/);
    }
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    must(state, { type: "use", by: "ann", unit: "ann", ability: "stoke_the_fire" });
    expect(foe).toBeDefined();
  });

  it("gives a cooldown of 1 (once a turn) or more to everything but a weapon's basic attack", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(5, 6), at(7, 6));
    unit(state, "ann").abilities = ["bash", "armor_crush"];
    // Once a turn: not again this turn, ready again the next.
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "armor_crush", target: foe });
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "armor_crush", target: foe })).toMatch(/not ready/);
    // The basic attack: as often as the AP allow.
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe });
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe })).toMatch(/takes 2 AP/);
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    must(state, { type: "use", by: "ann", unit: "ann", ability: "armor_crush", target: foe });
    const basic = new Set([...Object.values(WEAPONS).map((w) => w.abilities[0]), "punch", "torch_swing", "turtle_bite", "sailor_pistol", "sailor_scimitar"]);
    for (const [id, t] of Object.entries(TACTICS)) {
      if (basic.has(id) && !t.cooldown) continue;
      expect(t.cooldown, id).toBeGreaterThanOrEqual(1);
    }
    for (const w of Object.values(WEAPONS)) for (const id of w.abilities.slice(1)) expect(tacticOf(id).cooldown, id).toBeGreaterThanOrEqual(1);
  });

  it("spends Focus for advantage", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(6, 6), at(8, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe, focus: true }, events);
    expect(unit(state, "ann").focus).toBe(1);
    const roll = events.find((e) => e.t === "roll" && e.roll.kind === "attack");
    expect(roll && roll.t === "roll" && roll.roll.adv).toBe(1);
  });
});

describe("opportunity attacks", () => {
  it("strikes a hero who walks out of an enemy's reach, once a round, and not one who disengaged", () => {
    let { state, foe } = duel("bandit", "qa_paladin", at(6, 6), at(8, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }, events);
    expect(events.some((e) => e.t === "reaction" && e.id === foe && e.target === "ann")).toBe(true);
    expect(state.encounter!.reacted).toContain(foe);
    // Back in and out again in the same round: its reaction is spent.
    state.encounter!.budgets.ann.move = 10;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) });
    const again: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }, again);
    expect(again.some((e) => e.t === "reaction")).toBe(false);
  });

  it("lets a hero who disengaged walk away untouched, and does not strike for moving around within reach", () => {
    let { state } = duel("bandit", "qa_paladin", at(6, 6), at(8, 6));
    const round: ZoneEvent[] = [];
    // From one hex beside it to another beside it.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 5) }, round);
    expect(round.some((e) => e.t === "reaction")).toBe(false);
    state = must(state, { type: "common", by: "ann", unit: "ann", what: "disengage" });
    const away: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 4) }, away);
    expect(away.some((e) => e.t === "reaction")).toBe(false);
  });

  it("lets a hero strike an enemy that walks away from them", () => {
    const { state, foe } = duel("bandit", "qa_paladin", at(6, 6), at(8, 6));
    const bandit = unit(state, foe);
    const events: ZoneEvent[] = [];
    const ctx: Ctx = { state, rng: makeRng(7), events, effects: [] };
    walk(ctx, bandit, [at(9, 6), at(10, 6)], { ap: AP_TURN, move: 5, stride: 2, disengaged: false });
    expect(events.some((e) => e.t === "reaction" && e.id === "ann" && e.target === foe)).toBe(true);
    expect(events.some((e) => e.t === "roll" && e.roll.id === "ann" && e.roll.kind === "attack")).toBe(true);
    expect(state.encounter!.reacted).toContain("ann");
  });
});

// ---------- the ground ----------

describe("surfaces", () => {
  it("hurts and poisons whoever walks into poison, and wears off after its rounds", () => {
    let { state } = duel("dummy", "qa_paladin", at(4, 6), at(8, 6));
    state = paint(state, "poison", [at(6, 6)]);
    const hp = unit(state, "ann").hp;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }, events);
    expect(unit(state, "ann").hp).toBeLessThan(hp);
    expect(unit(state, "ann").conditions.some((c) => c.kind === "poisoned")).toBe(true);
    expect(events.some((e) => e.t === "tick" && e.kind === "poison")).toBe(true);
    const rounds = state.surfaces[posKey(at(6, 6))].rounds;
    const round = state.encounter!.round;
    while (state.encounter && state.encounter.round < round + rounds) state = must(state, { type: "timeout" });
    expect(state.surfaces[posKey(at(6, 6))]).toBeUndefined();
  });

  it("runs fire through every joined hex of oil", () => {
    let state = board();
    state = paint(state, "oil", [at(5, 6), at(6, 6), at(7, 6), at(10, 2)]);
    state = paint(state, "fire", [at(5, 6)]);
    for (const p of [at(5, 6), at(6, 6), at(7, 6)]) expect(state.surfaces[posKey(p)].kind).toBe("fire");
    expect(state.surfaces[posKey(at(10, 2))].kind).toBe("oil");
  });

  it("sets poison off as a burst that hurts whoever stands in it", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(6, 6));
    state = paint(state, "poison", [at(6, 6), at(7, 6)]);
    const hp = unit(state, "ann").hp;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "dev", by: "dev", dev: { op: "paint", kind: "fire", hexes: [at(7, 6)] } }, events);
    expect(events.some((e) => e.t === "burst")).toBe(true);
    expect(state.surfaces[posKey(at(6, 6))].kind).toBe("fire");
    expect(unit(state, "ann").hp).toBeLessThan(hp);
    expect(ann.id).toBe("ann");
  });

  it("puts fire out with water, freezes water, and melts ice", () => {
    let state = board();
    state = paint(state, "fire", [at(5, 6)]);
    state = paint(state, "water", [at(5, 6)]);
    expect(state.surfaces[posKey(at(5, 6))]).toBeUndefined();
    state = paint(state, "water", [at(5, 6)]);
    state = paint(state, "ice", [at(5, 6)]);
    expect(state.surfaces[posKey(at(5, 6))].kind).toBe("ice");
    state = paint(state, "fire", [at(5, 6)]);
    expect(state.surfaces[posKey(at(5, 6))].kind).toBe("water");
  });

  it("makes oil cost a step more, and soaks whoever crosses water so they cannot burn", () => {
    let { state } = duel("dummy", "qa_paladin", at(4, 6), at(9, 6));
    state = paint(state, "oil", [at(6, 6)]);
    state = paint(state, "water", [at(7, 6)]);
    state = paint(state, "fire", [at(8, 5)]);
    state.encounter!.budgets.ann.move = 10;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(state.encounter!.budgets.ann.move).toBe(10 - 2);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) });
    expect(unit(state, "ann").conditions.some((c) => c.kind === "wet")).toBe(true);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 5) });
    expect(unit(state, "ann").conditions.some((c) => c.kind === "burning")).toBe(false);
  });

  it("makes slime cost a step more and slow whoever walks in; fire burns it off and water washes it away", () => {
    let { state } = duel("dummy", "qa_paladin", at(4, 6), at(9, 6));
    state = paint(state, "slime", [at(6, 6)]);
    state.encounter!.budgets.ann.move = 10;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    // A step onto it costs two, and the slowing halves what is left.
    expect(state.encounter!.budgets.ann.move).toBe(Math.floor((10 - 2) / 2));
    expect(unit(state, "ann").conditions.some((c) => c.kind === "slowed")).toBe(true);
    let ground = board();
    ground = paint(ground, "slime", [at(5, 6), at(6, 6)]);
    ground = paint(ground, "fire", [at(5, 6)]);
    expect(ground.surfaces[posKey(at(5, 6))]).toMatchObject({ kind: "fire", rounds: 1 });
    // Fire does not run along slime as it does along oil.
    expect(ground.surfaces[posKey(at(6, 6))].kind).toBe("slime");
    ground = paint(ground, "water", [at(6, 6)]);
    expect(ground.surfaces[posKey(at(6, 6))]).toBeUndefined();
    // Slime thrown on a fire smothers it.
    ground = paint(ground, "fire", [at(8, 6)]);
    ground = paint(ground, "slime", [at(8, 6)]);
    expect(ground.surfaces[posKey(at(8, 6))]).toBeUndefined();
  });

  it("leaves those an acid flask splashes Exposed unless they dodge, and lays a slick where a slime flask lands", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6)).items = { acid: 1, slime: 1 };
    const foes = [enemy(state, "dummy", at(8, 6)), enemy(state, "dummy", at(9, 6)), enemy(state, "dummy", at(8, 7))];
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "acid", at: foes[0].pos }, events);
    expect(unit(state, "ann").items.acid ?? 0).toBe(0);
    for (const f of foes) {
      const save = events.find((e) => e.t === "roll" && e.roll.kind === "save" && e.roll.id === f.id);
      expect(save).toBeDefined();
      const exposed = unit(state, f.id).conditions.some((c) => c.kind === "exposed");
      expect(exposed).toBe(save!.t === "roll" && !save!.roll.ok);
    }
    expect(events.some((e) => e.t === "hit" && e.what === "throw:acid")).toBe(true);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "slime", at: at(6, 3) });
    expect(state.surfaces[posKey(at(6, 3))]).toMatchObject({ kind: "slime", rounds: 3 });
  });

  it("lays poison where a flask lands, and starts the fight if it lands on a group", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    const wolf = enemy(state, "wolf", at(8, 6));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "poison", at: wolf.pos }, events);
    expect(state.surfaces[posKey(wolf.pos)].kind).toBe("poison");
    expect(Object.keys(state.surfaces)).toHaveLength(7);
    expect(unit(state, "ann").items.poison).toBe(1);
    expect(unit(state, wolf.id).conditions.some((c) => c.kind === "poisoned")).toBe(true);
    expect(state.encounter).not.toBeNull();
    // Laid on open ground with nobody near, it starts nothing.
    let quiet = board();
    hero(quiet, "ann", "qa_paladin", at(3, 6));
    enemy(quiet, "wolf", at(14, 6));
    quiet = must(quiet, { type: "throw", by: "ann", unit: "ann", item: "poison", at: at(6, 6) });
    expect(quiet.encounter).toBeNull();
    expect(fails(quiet, { type: "throw", by: "ann", unit: "ann", item: "poison", at: at(15, 2) })).toMatch(/Too far/);
  });
});

describe("light and the dark", () => {
  /** A cave board: dark but where a torch or a fire lights it. */
  const cave = () => {
    const state = board();
    state.options = { ...state.options, biome: "caves" };
    return state;
  };

  it("lights a torch from the pack to hold, for a Bonus action in a fight, and not a second while one burns", () => {
    let { state } = duel("dummy");
    state.options = { ...state.options, biome: "caves" };
    unit(state, "ann").items.torch = 2;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "light", by: "ann", unit: "ann" }, events);
    expect(unit(state, "ann")).toMatchObject({ torch: TORCH_HELD_ROUNDS, items: { torch: 1 } });
    expect(state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - BONUS_AP);
    expect(events).toContainEqual({ t: "lit", id: "ann" });
    expect(fails(state, { type: "light", by: "ann", unit: "ann" })).toMatch(/already/);
  });

  it("hides an enemy in the dark from the party, and shows it once a torch or a hero is near", () => {
    let state = cave();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.outfit = IN_A_DIVING_HELM;
    ann.items.torch = 1;
    const wolf = enemy(state, "wolf", at(9, 6));
    expect(zoneView(state, "ann").units.map((u) => u.id)).toEqual(["ann"]);
    state = must(state, { type: "light", by: "ann", unit: "ann" });
    expect(zoneView(state, "ann").units.map((u) => u.id)).toEqual(["ann"]);
    // Walked up within the torch's reach, it is seen.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(9 - LIGHT_RADIUS, 6) });
    expect(zoneView(state, "ann").units.map((u) => u.id)).toContain(wolf.id);
    // Out of the caves nothing is hidden.
    const open = board();
    hero(open, "ann", "qa_paladin", at(3, 6));
    enemy(open, "wolf", at(14, 6));
    expect(zoneView(open, "ann").units).toHaveLength(2);
  });

  it("lights the dark around a Paladin in the lantern helm (their starter hat) as far as a torch does, and it never burns down", () => {
    let state = cave();
    state.aiOff = true;
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.outfit = { ...IN_THE_LANTERN_HELM, appearance: DEFAULT_APPEARANCE };
    const wolf = enemy(state, "wolf", at(3 + LIGHT_RADIUS, 6));
    let lit = litHexes(state)!;
    expect(lit.has(posKey(at(3 + LIGHT_RADIUS, 6)))).toBe(true);
    expect(lit.has(posKey(at(4 + LIGHT_RADIUS, 6)))).toBe(false);
    expect(zoneView(state, "ann").units.map((u) => u.id)).toContain(wolf.id);
    // Lit as it walks, with no torch in hand to burn down.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) });
    lit = litHexes(state)!;
    expect(lit.has(posKey(at(5 + LIGHT_RADIUS, 6)))).toBe(true);
    expect(unit(state, "ann").torch).toBeUndefined();
  });

  it("gives no light from any other helmet, a bare head, or another class's starter hat, but does from the lantern helm on anyone", () => {
    const state = cave();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    const near = at(4, 6);
    ann.outfit = IN_A_DIVING_HELM;
    expect(litHexes(state)!.has(posKey(near))).toBe(false);
    // Bare-headed, with a look of their own: nothing on the head.
    ann.outfit = { appearance: DEFAULT_APPEARANCE };
    expect(litHexes(state)!.has(posKey(near))).toBe(false);
    // Another class's starter hat is a plain knitted cap.
    ann.kind = "refactor_rogue";
    ann.outfit = IN_A_KNIT_CAP;
    expect(litHexes(state)!.has(posKey(near))).toBe(false);
    // But the Paladin's, passed on through the crew's chest, lights the dark for whoever wears it.
    ann.outfit = IN_THE_LANTERN_HELM;
    expect(litHexes(state)!.has(posKey(near))).toBe(true);
  });

  it("lights the dark from a lantern helm worn hidden, though the head is drawn bare", () => {
    const state = cave();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.outfit = { appearance: DEFAULT_APPEARANCE };
    expect(litHexes(state)!.has(posKey(at(4, 6)))).toBe(false);
    ann.lantern = true;
    expect(litHexes(state)!.has(posKey(at(4, 6)))).toBe(true);
  });

  it("will not pick out an enemy in the dark, and strikes blind at one beside you that is unlit", () => {
    let state = cave();
    state.aiOff = true;
    const ann = hero(state, "ann", "refactor_rogue", at(3, 6));
    const far = enemy(state, "dummy", at(6, 6));
    expect(checkAbility(state, ann, "bow_shot", { target: far.id })).toMatch(/too dark/);
    const near = enemy(state, "dummy", at(4, 6), "g2");
    expect(attackContext(state, ann, near, { melee: true }).notes).toContain("Disadvantage: the target is in the dark");
    ann.torch = 5;
    expect(checkAbility(state, ann, "bow_shot", { target: far.id })).toBeNull();
    expect(attackContext(state, ann, near, { melee: true }).notes).not.toContain("Disadvantage: the target is in the dark");
    // The enemy sees in the dark.
    ann.torch = undefined;
    expect(attackContext(state, near, ann, { melee: true }).notes.some((n) => n.includes("dark"))).toBe(false);
    expect(state.units).toHaveLength(3);
  });

  it("throws a torch down to burn where it lands, setting oil alight, and it burns out round by round", () => {
    let { state } = duel("dummy", "qa_paladin", at(4, 6), at(12, 2));
    state.options = { ...state.options, biome: "caves" };
    unit(state, "ann").items.torch = 1;
    state = paint(state, "oil", [at(7, 6), at(8, 6)]);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(7, 6) }, events);
    expect(unit(state, "ann").items.torch ?? 0).toBe(0);
    expect(state.lights?.[posKey(at(7, 6))]).toMatchObject({ rounds: TORCH_GROUND_ROUNDS });
    for (const p of [at(7, 6), at(8, 6)]) expect(state.surfaces[posKey(p)].kind).toBe("fire");
    expect(events).toContainEqual({ t: "light", at: at(7, 6), on: true });
    const round = state.encounter!.round;
    while (state.encounter && state.encounter.round < round + TORCH_GROUND_ROUNDS) state = must(state, { type: "timeout" });
    expect(state.lights?.[posKey(at(7, 6))]).toBeUndefined();
  });

  it("throws the lit torch from the hand with none left in the pack, and goes out in water", () => {
    let state = cave();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.items = {};
    ann.torch = 4;
    state = paint(state, "water", [at(6, 2)]);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(5, 6) });
    expect(unit(state, "ann").torch).toBeUndefined();
    expect(state.lights?.[posKey(at(5, 6))]).toMatchObject({ rounds: 4 });
    expect(fails(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(5, 6) })).toMatch(/no torch/);
    unit(state, "ann").items.torch = 1;
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(6, 2) });
    expect(state.lights?.[posKey(at(6, 2))]).toBeUndefined();
    // Water thrown over a burning torch puts it out.
    state = paint(state, "water", [at(5, 6)]);
    expect(state.lights?.[posKey(at(5, 6))]).toBeUndefined();
  });

  it("swings a torch lit in the main hand as a weapon that may set its target Burning, the weapon put away till it goes", () => {
    let { state, foe } = duel("dummy");
    const ann = unit(state, "ann");
    ann.items.torch = 1;
    ann.outfit = { off_hand: { icon: "round-shield", ref: "buckler", rarity: "common" } };
    const guarded = defenceOf(ann);
    const weapon = [...ann.abilities];
    state = must(state, { type: "light", by: "ann", unit: "ann", hand: "main" });
    expect(unit(state, "ann")).toMatchObject({ torchHand: "main", abilities: ["torch_swing"], stowed: weapon });
    // The shield is still on the other arm.
    expect(defenceOf(unit(state, "ann"))).toBe(guarded);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: weapon[0], target: foe })).toMatch(/do not have/);
    // Swung until it lands: a hit offers the target a save against catching fire, and a failed one sets it Burning.
    let burned = false;
    let saved = false;
    for (let seed = 1; seed < 60 && !(burned && saved); seed++) {
      const tryIt = structuredClone(state);
      tryIt.rng = seed;
      const target = unit(tryIt, foe);
      target.pos = { q: unit(tryIt, "ann").pos.q + 1, r: unit(tryIt, "ann").pos.r };
      const step = stepZone(tryIt, { type: "use", by: "ann", unit: "ann", ability: "torch_swing", target: foe });
      if (!step.ok) throw new Error(step.error);
      const resist = step.events.find((e) => e.t === "roll" && e.roll.kind === "save");
      if (!resist || resist.t !== "roll") continue;
      const burning = unit(step.state, foe).conditions.some((c) => c.kind === "burning");
      expect(burning).toBe(!resist.roll.ok);
      if (burning) burned = true;
      else saved = true;
    }
    expect(burned).toBe(true);
    // Thrown down, the weapon is taken up again.
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "torch", at: at(3, 3) });
    expect(unit(state, "ann").abilities).toEqual(weapon);
    expect(unit(state, "ann").torchHand).toBeUndefined();
  });

  it("burns a held torch down only while a fight goes on, and sets the shield aside while it is held", () => {
    let { state } = duel("dummy");
    const ann = unit(state, "ann");
    ann.outfit = { off_hand: { icon: "round-shield", ref: "buckler", rarity: "common" } };
    const guarded = defenceOf(ann);
    ann.torch = 2;
    expect(defenceOf(ann)).toBe(guarded - SHIELD_SET_ASIDE);
    const events: ZoneEvent[] = [];
    const round = state.encounter!.round;
    while (state.encounter && state.encounter.round < round + 2) state = must(state, { type: "timeout" }, events);
    expect(unit(state, "ann").torch).toBeUndefined();
    expect(events).toContainEqual({ t: "torch_out", id: "ann" });
    expect(defenceOf(unit(state, "ann"))).toBe(guarded);
  });
});

describe("time out of a fight", () => {
  const T0 = 1_000_000;
  const tell = (state: ZoneState, now: number, sink: ZoneEvent[] = []) => must(state, { type: "time", now }, sink);

  it("starts counting from the first time it is told, without anything passing", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6)).torch = 3;
    state = paint(state, "poison", [at(8, 6)]);
    const rounds = state.surfaces[posKey(at(8, 6))].rounds;
    state = tell(state, T0);
    expect(state.clock).toEqual({ at: T0, torchAt: T0 });
    expect(state.surfaces[posKey(at(8, 6))].rounds).toBe(rounds);
    expect(unit(state, "ann").torch).toBe(3);
  });

  it("counts every six seconds out of a fight as a round: the ground wears, burning burns, conditions run down", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.conditions = [{ kind: "burning", rounds: 2 }, { kind: "slowed", rounds: 5 }];
    state = paint(state, "oil", [at(8, 6)]);
    const oil = state.surfaces[posKey(at(8, 6))].rounds;
    state = tell(state, T0);
    const hp = unit(state, "ann").hp;
    const events: ZoneEvent[] = [];
    // Two rounds and a bit: two rounds pass, and the bit is kept for next time.
    state = tell(state, T0 + 2 * EXPLORE_ROUND_MS + 2_000, events);
    expect(state.clock!.at).toBe(T0 + 2 * EXPLORE_ROUND_MS);
    expect(state.surfaces[posKey(at(8, 6))].rounds).toBe(oil - 2);
    expect(unit(state, "ann").hp).toBe(hp - 2 * EFFECT_TICK.burning!);
    expect(unit(state, "ann").conditions).toEqual([{ kind: "slowed", rounds: 3 }]);
    expect(events.filter((e) => e.t === "tick" && e.kind === "burning")).toHaveLength(2);
  });

  it("counts a long absence as a few rounds at most, and catches the clock up", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6)).conditions = [{ kind: "bleeding", rounds: 30 }];
    state = tell(state, T0);
    const events: ZoneEvent[] = [];
    state = tell(state, T0 + 3_600_000, events);
    expect(events.filter((e) => e.t === "tick")).toHaveLength(MAX_CATCHUP_ROUNDS);
    expect(state.clock!.at).toBe(T0 + 3_600_000);
  });

  it("burns torches on a far kinder clock out of a fight, held or lying on the ground", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6)).torch = 2;
    state.lights = { [posKey(at(6, 6))]: { rounds: 1, by: "ann" } };
    state = tell(state, T0);
    // A minute and a half less a moment: nothing yet, though the ground has had its rounds.
    state = tell(state, T0 + TORCH_ROUND_MS - 1);
    expect(unit(state, "ann").torch).toBe(2);
    expect(state.lights![posKey(at(6, 6))]).toBeDefined();
    const events: ZoneEvent[] = [];
    state = tell(state, T0 + TORCH_ROUND_MS, events);
    expect(unit(state, "ann").torch).toBe(1);
    expect(state.lights![posKey(at(6, 6))]).toBeUndefined();
    expect(events).toContainEqual({ t: "light", at: at(6, 6), on: false });
    state = tell(state, T0 + 2 * TORCH_ROUND_MS, events);
    expect(unit(state, "ann").torch).toBeUndefined();
    expect(events).toContainEqual({ t: "torch_out", id: "ann" });
  });

  it("leaves time to the fight's own rounds while one is on", () => {
    let { state } = duel("dummy");
    unit(state, "ann").torch = 3;
    state = tell(state, T0);
    state = tell(state, T0 + 10 * TORCH_ROUND_MS);
    expect(unit(state, "ann").torch).toBe(3);
    expect(state.clock).toEqual({ at: T0 + 10 * TORCH_ROUND_MS, torchAt: T0 + 10 * TORCH_ROUND_MS });
  });
});

describe("picking up a torch", () => {
  it("takes a torch burning on the ground into a free hand, with what it has left to burn", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6)).items = {};
    state.lights = { [posKey(at(4, 6))]: { rounds: 5, by: "bo" } };
    const events: ZoneEvent[] = [];
    state = must(state, { type: "pickup", by: "ann", unit: "ann", at: at(4, 6) }, events);
    expect(unit(state, "ann").torch).toBe(5);
    expect(state.lights![posKey(at(4, 6))]).toBeUndefined();
    expect(events).toContainEqual({ t: "took_torch", id: "ann", at: at(4, 6), stowed: false });
    expect(fails(state, { type: "pickup", by: "ann", unit: "ann", at: at(4, 6) })).toMatch(/no torch/);
  });

  it("puts it out and stows it in the pack with a torch already in hand, and wants you beside it", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.items = { torch: 1 };
    ann.torch = 7;
    state.lights = { [posKey(at(4, 6))]: { rounds: 2, by: null }, [posKey(at(9, 6))]: { rounds: 2, by: null } };
    expect(fails(state, { type: "pickup", by: "ann", unit: "ann", at: at(9, 6) })).toMatch(/Go up to it/);
    state = must(state, { type: "pickup", by: "ann", unit: "ann", at: at(4, 6) });
    expect(unit(state, "ann")).toMatchObject({ torch: 7, items: { torch: 2 } });
  });

  it("costs 1 AP in a fight", () => {
    let { state } = duel("dummy");
    state.lights = { [posKey(at(5, 5))]: { rounds: 3, by: null }, [posKey(at(5, 7))]: { rounds: 3, by: null } };
    state = must(state, { type: "pickup", by: "ann", unit: "ann", at: at(5, 5) });
    expect(state.encounter!.budgets.ann.ap).toBe(AP_TURN - BONUS_AP);
    state.encounter!.budgets.ann.ap = 0;
    expect(fails(state, { type: "pickup", by: "ann", unit: "ann", at: at(5, 7) })).toMatch(/takes 1 AP/);
  });
});

describe("putting a held torch away", () => {
  it("puts out a torch swung in the main hand and stows it in the pack, and the weapon is taken up again", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.items = { torch: 1 };
    const weapon = [...ann.abilities];
    state = must(state, { type: "light", by: "ann", unit: "ann", hand: "main" });
    expect(unit(state, "ann")).toMatchObject({ torchHand: "main", abilities: ["torch_swing"], items: { torch: 0 } });
    const events: ZoneEvent[] = [];
    state = must(state, { type: "stow", by: "ann", unit: "ann" }, events);
    const after = unit(state, "ann");
    expect(after.abilities).toEqual(weapon);
    expect(after.items.torch).toBe(1);
    expect(after.torch).toBeUndefined();
    expect(after.torchHand).toBeUndefined();
    expect(after.stowed).toBeUndefined();
    expect(events).toContainEqual({ t: "torch_stowed", id: "ann" });
    // With none in hand there is nothing to put away, and it can be lit again.
    expect(fails(state, { type: "stow", by: "ann", unit: "ann" })).toMatch(/not holding/);
    must(state, { type: "light", by: "ann", unit: "ann" });
  });

  it("takes up the weapon put on while the torch was in the main hand", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.items = { torch: 1 };
    state = must(state, { type: "light", by: "ann", unit: "ann", hand: "main" });
    // Gear changed in the bag meanwhile: the map hears of it, and the torch stays in the hand.
    unit(state, "ann").stowed = ["cleave"];
    state = must(state, { type: "stow", by: "ann", unit: "ann" });
    expect(unit(state, "ann").abilities).toEqual(["cleave"]);
  });

  it("takes the shield up again from the off hand", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.items = { torch: 1 };
    ann.outfit = { off_hand: { icon: "round-shield", ref: "buckler", rarity: "common" } };
    const guarded = defenceOf(ann);
    const weapon = [...ann.abilities];
    state = must(state, { type: "light", by: "ann", unit: "ann" });
    expect(defenceOf(unit(state, "ann"))).toBe(guarded - SHIELD_SET_ASIDE);
    state = must(state, { type: "stow", by: "ann", unit: "ann" });
    expect(defenceOf(unit(state, "ann"))).toBe(guarded);
    expect(unit(state, "ann")).toMatchObject({ abilities: weapon, items: { torch: 1 } });
  });

  it("costs 1 AP in a fight, and is not done while down", () => {
    let { state } = duel("dummy");
    unit(state, "ann").items.torch = 2;
    state = must(state, { type: "light", by: "ann", unit: "ann", hand: "main" });
    state.encounter!.budgets.ann.ap = 0;
    expect(fails(state, { type: "stow", by: "ann", unit: "ann" })).toMatch(/takes 1 AP/);
    expect(unit(state, "ann").torchHand).toBe("main");
    const fresh = duel("dummy").state;
    unit(fresh, "ann").torch = 4;
    const stowed = must(fresh, { type: "stow", by: "ann", unit: "ann" });
    expect(stowed.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - BONUS_AP);
    const down = board();
    const bo = hero(down, "bo", "qa_paladin", at(3, 6));
    bo.torch = 4;
    bo.down = true;
    expect(fails(down, { type: "stow", by: "bo", unit: "bo" })).toMatch(/down/);
  });
});

describe("items", () => {
  it("heals the drinker in full for a Bonus action, and uses the potion up", () => {
    let { state } = duel("dummy");
    unit(state, "ann").hp = 5;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "drink", by: "ann", unit: "ann", item: "healing" }, events);
    const healed = events.find((e) => e.t === "heal");
    expect(healed && healed.t === "heal" && healed.amount).toBeGreaterThanOrEqual(8);
    expect(unit(state, "ann").items.healing).toBe(1);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    expect(fails(state, { type: "drink", by: "ann", unit: "ann", item: "poison" })).toMatch(/not for drinking/);
  });

  it("heals whoever a thrown potion lands on, and half as much those on the six hexes round them", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(3, 6));
    const centre = hero(state, "bo", "qa_paladin", at(6, 6));
    const edge = hero(state, "cy", "qa_paladin", at(7, 6));
    const outside = hero(state, "di", "qa_paladin", at(8, 6));
    for (const h of [centre, edge, outside]) h.hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "healing", at: at(6, 6) }, events);
    const got = (id: string) => events.find((e) => e.t === "heal" && e.target === id);
    const full = got("bo");
    const half = got("cy");
    expect(full && full.t === "heal" && half && half.t === "heal" && half.amount).toBe(Math.ceil((full && full.t === "heal" ? full.amount : 0) / 2));
    expect(got("di")).toBeUndefined();
    expect(unit(state, "di").hp).toBe(1);
    // Seven hexes in all: the one it lands on and the six around.
    expect(zoneBlastCount(state, at(6, 6))).toBe(7);
    expect(unit(state, "ann").items.healing).toBe(1);
  });
});

// ---------- the enemy ----------

describe("threat", () => {
  it("makes the enemy tougher, sharper and more numerous as it rises", () => {
    expect(enemyHp("wolf", 1, 1)).toBe(Math.round(ENEMIES.wolf.hp * ENEMY_HP_SCALE));
    expect(enemyHp("wolf", 1, 2)).toBeGreaterThan(enemyHp("wolf", 1, 1) * 1.5);
    expect(enemyHp("wolf", 1, 3)).toBeGreaterThan(enemyHp("wolf", 1, 2));
    expect(enemyStrikes("wolf", 1, 3)[0].bonus).toBe(enemyStrikes("wolf", 1, 1)[0].bonus + 2);
    // A band is as many as the party (one more, for a party of three or four), and one more again for each step of
    // threat past the first: never fewer than two.
    const bands = (party: number, threat: number) => {
      const zone = createZone("T", "threat", zoneOptions({ groups: 2, kinds: ["wolf"], party, threat }));
      return Object.keys(zone.groups).map((g) => zone.units.filter((u) => u.group === g).length);
    };
    expect(bands(2, 1)).toEqual([2, 2]);
    expect(bands(2, 2)).toEqual([3, 3]);
    expect(bands(2, 3)).toEqual([4, 4]);
    // A lone hero meets two at any ordinary threat; four heroes, five or six.
    expect(bands(1, 1)).toEqual([2, 2]);
    expect(bands(1, 2)).toEqual([2, 2]);
    expect(bands(1, 3)).toEqual([3, 3]);
    expect(bands(4, 1)).toEqual([5, 5]);
    expect(bands(4, 2)).toEqual([6, 6]);
    // A zone made before there was a threat is a fair fight.
    expect(zoneOptions({}).threat).toBe(2);
  });
});

describe("the enemy's turn", () => {
  it("goes about as far on an AP as an ordinary hero does, and the quick a step further: never more than 3", () => {
    // What each of them covers for 1 AP on open ground. An ordinary hero covers 2 (rules.ts heroMove).
    const strides: Record<string, number> = {
      dummy: 0,
      bandit: 2, skeleton: 2, cultist: 2, brute: 2, bear: 2, ogre: 2, troll: 2, slime: 2, snow_bear: 2, wraith: 2, witch: 2,
      wolf: 3, frost_wolf: 3, ember_hound: 3, spider: 3, archer: 3, shade: 3, bat: 3,
      alpha: 3, great_bear: 2, guardian: 2, haunt: 2, broodmother: 2, villain: 2,
    };
    expect(Object.keys(strides).sort()).toEqual(Object.keys(ENEMIES).sort());
    for (const kind of Object.keys(ENEMIES)) expect(enemyMove(kind), kind).toBe(strides[kind]);
    expect(heroMove({ ...STARTING_STATS.qa_paladin, agi: 5 })).toBe(2);
    expect(Math.max(...Object.keys(ENEMIES).map((kind) => enemyMove(kind)))).toBe(3);
    // What a map's modifiers add comes on top.
    expect(enemyMove("bandit", 1)).toBe(3);
    expect(enemyMove("bat", 1)).toBe(4);
    expect(ENEMY_MOVE_AP).toBe(2);
  });

  it("runs when nothing is in reach, but puts no more than two of its AP into the ground in a turn, and keeps the rest", () => {
    let state = board();
    Object.assign(hero(state, "ann", "qa_paladin", at(1, 6)), { hp: 900, maxHp: 900 });
    const bear = enemy(state, "bear", at(13, 6));
    const events: ZoneEvent[] = [];
    state = provoke(state, "ann", events);
    const stepsOf = (told: ZoneEvent[]) => told.filter((e): e is Extract<ZoneEvent, { t: "moved" }> => e.t === "moved" && e.id === bear.id).flatMap((e) => e.path).length;
    for (let i = 0; i < 3 && stepsOf(events) === 0; i++) state = must(state, { type: "timeout" }, events);
    // A bear covers 2 for each AP, and two AP are all it walks with: 4 hexes of open ground, straight at her.
    expect(enemyMove("bear") * ENEMY_MOVE_AP).toBe(4);
    expect(stepsOf(events)).toBe(4);
    expect(hexDistance(unit(state, bear.id).pos, at(1, 6))).toBe(12 - 4);
    // The two it did not spend are kept for its next turn.
    expect(state.encounter!.banked?.[bear.id]).toBe(AP_TURN - ENEMY_MOVE_AP);
    // It comes on at that pace, with all the AP it has saved, and in the turn it gets to her it strikes as well.
    const turns: ZoneEvent[][] = [];
    for (let i = 0; i < 6 && !turns.some((told) => told.some((e) => e.t === "used" && e.id === bear.id)); i++) {
      const told: ZoneEvent[] = [];
      state = must(state, { type: "timeout" }, told);
      turns.push(told);
    }
    expect(turns.length).toBe(2);
    for (const told of turns) expect(stepsOf(told)).toBeLessThanOrEqual(4);
    const last = turns[turns.length - 1];
    expect(stepsOf(last)).toBeGreaterThan(0);
    expect(last.filter((e) => e.t === "used" && e.id === bear.id && e.what === "attack").length).toBeGreaterThanOrEqual(1);
    expect(adjacent(unit(state, bear.id).pos, unit(state, "ann").pos)).toBe(true);
  });

  it("is held to two AP of movement, which a hero is not; what lengthens its stride (Hasted) still does", () => {
    const run = (hasted: boolean) => {
      let state = board();
      Object.assign(hero(state, "ann", "qa_paladin", at(1, 6)), { hp: 900, maxHp: 900 });
      const wolf = enemy(state, "wolf", at(15, 6));
      if (hasted) wolf.conditions.push({ kind: "hasted", rounds: 9 });
      const events: ZoneEvent[] = [];
      state = provoke(state, "ann", events);
      const steps = () => events.filter((e): e is Extract<ZoneEvent, { t: "moved" }> => e.t === "moved" && e.id === wolf.id).flatMap((e) => e.path).length;
      for (let i = 0; i < 3 && steps() === 0; i++) state = must(state, { type: "timeout" }, events);
      return { state, steps: steps() };
    };
    // A wolf covers 3 for each AP: 6 hexes in its turn, and twice that Hasted, the same two AP spent.
    expect(run(false).steps).toBe(ENEMY_MOVE_AP * enemyMove("wolf"));
    expect(run(true).steps).toBe(ENEMY_MOVE_AP * enemyMove("wolf") * 2);
    // A hero's budget has no such limit: all four of her AP can go on walking.
    const { state } = run(false);
    expect(state.encounter!.acting).toEqual(["ann"]);
    expect(state.encounter!.budgets.ann.walk).toBeUndefined();
    expect(moveLeft(state.encounter!.budgets.ann)).toBe(AP_TURN * heroMove(unit(state, "ann").stats!));
    // An enemy's says how many it may still walk with, and movement is reckoned by it.
    expect(moveLeft({ ap: 4, move: 0, stride: 3, disengaged: false, walk: ENEMY_MOVE_AP })).toBe(6);
    expect(moveLeft({ ap: 6, move: 1, stride: 3, disengaged: false, walk: 1 })).toBe(4);
    expect(moveLeft({ ap: 1, move: 0, stride: 3, disengaged: false, walk: 2 })).toBe(3);
    expect(walkAp({ ap: 4, move: 0, stride: 3, disengaged: false, walk: 2 }, ACTION_AP)).toBe(2);
    expect(walkAp({ ap: 3, move: 0, stride: 3, disengaged: false, walk: 2 }, ACTION_AP)).toBe(1);
    expect(walkAp({ ap: 1, move: 0, stride: 3, disengaged: false }, ACTION_AP)).toBe(0);
  });

  it("closes on a hero and attacks", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(4, 6));
    const wolf = enemy(state, "wolf", at(9, 6));
    const events: ZoneEvent[] = [];
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }), "ann", events);
    for (let i = 0; i < 4 && !events.some((e) => e.t === "used" && e.id === wolf.id); i++) state = must(state, { type: "timeout" }, events);
    expect(events.some((e) => e.t === "used" && e.id === wolf.id)).toBe(true);
    expect(adjacent(unit(state, wolf.id).pos, unit(state, "ann").pos)).toBe(true);
  });

  it("walks round fire or poison when there is a clean way", () => {
    for (const kind of ["fire", "poison"] as const) {
      let state = board();
      hero(state, "ann", "qa_paladin", at(4, 6));
      const wolf = enemy(state, "wolf", at(9, 6));
      // A puddle right on the straight line between them, with open ground either side.
      state = paint(state, kind, [at(7, 6), at(6, 6)]);
      const events: ZoneEvent[] = [];
      state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }), "ann", events);
      for (let i = 0; i < 3 && !events.some((e) => e.t === "moved" && e.id === wolf.id); i++) state = must(state, { type: "timeout" }, events);
      const walked = events.filter((e): e is Extract<ZoneEvent, { t: "moved" }> => e.t === "moved" && e.id === wolf.id).flatMap((e) => e.path);
      expect(walked.length, kind).toBeGreaterThan(0);
      expect(walked.some((p) => state.surfaces[posKey(p)]), kind).toBe(false);
      expect(events.some((e) => e.t === "tick" && e.target === wolf.id), kind).toBe(false);
    }
  });

  it("keeps an archer at a distance when it can shoot from where it is", () => {
    let state = board();
    hero(state, "ann", "qa_paladin", at(4, 6));
    const archer = enemy(state, "archer", at(9, 6));
    const events: ZoneEvent[] = [];
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }), "ann", events);
    for (let i = 0; i < 3 && !events.some((e) => e.t === "used" && e.id === archer.id); i++) state = must(state, { type: "timeout" }, events);
    expect(events.some((e) => e.t === "used" && e.id === archer.id)).toBe(true);
    expect(hexDistance(unit(state, archer.id).pos, unit(state, "ann").pos)).toBeGreaterThan(1);
  });
});

// ---------- winning and losing ----------

describe("the end of a fight", () => {
  it("is won when every enemy in it is down: the dead are cleared and the fallen get up", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(6, 6));
    const bo = hero(state, "bo", "qa_paladin", at(6, 7));
    const foe = enemy(state, "bat", at(7, 6));
    state = must(state, { type: "common", by: "ann", unit: "ann", what: "shove", target: foe.id });
    expect(state.encounter).not.toBeNull();
    unit(state, "bo").down = true;
    unit(state, "bo").hp = 0;
    unit(state, foe.id).hp = 1;
    const events: ZoneEvent[] = [];
    for (let i = 0; i < 40 && state.encounter; i++) {
      const actor = state.encounter.acting.find((id) => !state.encounter!.done.includes(id) && id === "ann");
      if (!actor) { state = must(state, { type: "timeout" }, events); continue; }
      const target = unit(state, foe.id);
      if (!adjacent(target.pos, unit(state, "ann").pos)) {
        const reach = zoneReach(state, unit(state, "ann"), moveLeft(state.encounter.budgets.ann));
        const spot = [...reach.values()].filter((r) => r.stop && adjacent(r.pos, target.pos)).sort((a, b) => a.cost - b.cost)[0];
        if (spot) state = must(state, { type: "move", by: "ann", unit: "ann", to: spot.pos }, events);
      }
      const step = stepZone(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe.id, focus: unit(state, "ann").focus > 0 });
      if (step.ok) { state = step.state; events.push(...step.events); }
      if (state.encounter) state = must(state, { type: "end_turn", by: "ann", unit: "ann" }, events);
    }
    expect(state.encounter).toBeNull();
    expect(events.some((e) => e.t === "fight_end" && e.outcome === "victory")).toBe(true);
    expect(state.units.some((u) => u.side === "enemy")).toBe(false);
    expect(state.groups).toEqual({});
    expect(unit(state, "bo")).toMatchObject({ down: false, hp: 1 });
    expect(bo.id).toBe("bo");
  });

  it("is lost when every hero in it is down: they wake at the start and the enemy go home healed", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(3, 6));
    ann.hp = 1;
    const bear = enemy(state, "bear", at(9, 6));
    bear.hp = 3;
    const events: ZoneEvent[] = [];
    state = provoke(must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 6) }), "ann", events);
    for (let i = 0; i < 60 && state.encounter; i++) state = must(state, { type: "timeout" }, events);
    expect(events.some((e) => e.t === "fight_end" && e.outcome === "defeat")).toBe(true);
    expect(state.encounter).toBeNull();
    expect(unit(state, "ann")).toMatchObject({ down: false, hp: 1 });
    expect(hexDistance(unit(state, "ann").pos, state.start)).toBeLessThanOrEqual(1);
    expect(unit(state, bear.id)).toMatchObject({ hp: unit(state, bear.id).maxHp, pos: bear.home });
    expect(state.groups.g1.alerted).toBe(false);
  });

  it("pays a won fight's XP to each player's hero, never a stand-in's, leaves the fallen lying to be searched, and says when the map is cleared", () => {
    let { state, foe } = duel("skeleton");
    const fell = unit(state, foe).pos;
    const helper = hero(state, "bo", "devops_mage", at(3, 9));
    helper.controller = "ann";
    state.encounter!.order.push("bo");
    unit(state, foe).hp = 1;
    const events: ZoneEvent[] = [];
    const effects: ZoneEffect[] = [];
    for (let i = 0; i < 20 && state.encounter; i++) {
      if (!state.encounter.acting.includes("ann") || state.encounter.done.includes("ann")) { state = must(state, { type: "timeout" }, events); continue; }
      const target = unit(state, foe);
      if (!adjacent(target.pos, unit(state, "ann").pos)) {
        const reach = zoneReach(state, unit(state, "ann"), moveLeft(state.encounter.budgets.ann));
        const spot = [...reach.values()].filter((r) => r.stop && adjacent(r.pos, target.pos)).sort((a, b) => a.cost - b.cost)[0];
        if (spot) state = must(state, { type: "move", by: "ann", unit: "ann", to: spot.pos }, events);
      }
      const step = stepZone(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe });
      if (step.ok) { state = step.state; events.push(...step.events); effects.push(...step.effects); }
      if (state.encounter) state = must(state, { type: "end_turn", by: "ann", unit: "ann" }, events);
    }
    expect(events.some((e) => e.t === "fight_end" && e.outcome === "victory")).toBe(true);
    // The XP, and nothing else: nothing is put in anyone's pack for them.
    expect(effects).toEqual([{ type: "grant", heroId: "ann", xp: ENEMIES.skeleton.xp, resources: {} }]);
    expect(events).toContainEqual({ t: "spoils", id: "ann", xp: ENEMIES.skeleton.xp, resources: {} });
    // What the skeleton had is still on it: it lies where it fell, to be walked up to and searched.
    expect(state.units.some((u) => u.id === foe)).toBe(false);
    expect(state.loot).toEqual([{ id: foe, kind: "body", name: ENEMIES.skeleton.name, pos: fell, unit: "skeleton", level: 1, loot: {} }]);
    expect(events.some((e) => e.t === "cleared")).toBe(true);
  });

  it("says nothing of a cleared map while another group still stands", () => {
    let { state, foe } = duel("skeleton");
    enemy(state, "bat", at(14, 2), "g2");
    unit(state, foe).hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "dev", by: "ann", dev: { op: "end_fight" } }, events);
    expect(events.some((e) => e.t === "cleared")).toBe(false);
  });

  it("plays whole fights on generated maps without breaking its own rules", () => {
    let struck = 0;
    for (let seed = 0; seed < 9; seed++) {
      let state = createZone("PLAY", `play-${seed}`, zoneOptions({ size: "small", biome: (["meadow", "woods", "caves", "shore"] as const)[seed % 4], groups: 2, party: 2, clear: 3, obstacles: 2, elevation: 2, threat: (seed % 3) + 1 }));
      state = must(state, { type: "join", hero: standInHero("refactor_rogue", "ann", 3)! });
      state = must(state, { type: "join", hero: standInHero("devops_mage", "bo", 3)! });
      const kinds = new Map(state.units.map((u) => [u.id, u.kind]));
      const events: ZoneEvent[] = [];
      const check = () => {
        const where = `seed ${seed}`;
        // No hex holds more than it has room for (the dead take up none), and none holds fighters of both sides.
        const crowd = new Map<string, number>();
        const sides = new Map<string, Set<string>>();
        for (const u of state.units) {
          if (isDead(u)) continue;
          crowd.set(posKey(u.pos), (crowd.get(posKey(u.pos)) ?? 0) + 1);
          sides.set(posKey(u.pos), (sides.get(posKey(u.pos)) ?? new Set()).add(u.side));
        }
        expect(Math.max(...crowd.values()), where).toBeLessThanOrEqual(HEX_ROOM);
        expect(Math.max(...[...sides.values()].map((s) => s.size)), where).toBe(1);
        for (const b of Object.values(state.encounter?.budgets ?? {})) expect(b.walk ?? 0, where).toBeGreaterThanOrEqual(0);
        for (const u of state.units) {
          expect(u.hp, where).toBeGreaterThanOrEqual(0);
          expect(u.hp, where).toBeLessThanOrEqual(u.maxHp);
          // Only what flies may be over water, and nobody at all is off the land or on what bars the way.
          if (!flies(u)) expect(solid(state.map.tiles.find((t) => t.q === u.pos.q && t.r === u.pos.r)), where).toBe(false);
          expect(state.map.tiles.some((t) => t.q === u.pos.q && t.r === u.pos.r), where).toBe(true);
          expect(blockerAt(state, u.pos), where).toBe(false);
        }
        const enc = state.encounter;
        if (enc) {
          for (const id of enc.acting) expect(enc.order, where).toContain(id);
          // A turn is one fighter's alone, and nobody shares a place in the order.
          expect(enc.acting.length, where).toBeLessThanOrEqual(1);
          expect(new Set(enc.order.map((id) => `${enc.init[id]}/${enc.tie?.[id] ?? 0}`)).size, where).toBe(enc.order.length);
          for (const b of Object.values(enc.budgets)) expect(b.ap, where).toBeGreaterThanOrEqual(0);
        }
        // Whoever fell and was cleared away lies there to be searched; nobody lost to a pit does.
        for (const s of state.loot ?? []) expect(state.units.some((u) => u.id === s.id), where).toBe(false);
      };
      for (let step = 0; step < 150; step++) {
        if (!state.units.some((u) => u.side === "enemy" && !u.down)) break;
        for (const id of ["ann", "bo"]) {
          const me = unit(state, id);
          if (me.down) continue;
          const fighting = !!state.encounter?.order.includes(id);
          if (fighting && (!state.encounter!.acting.includes(id) || state.encounter!.done.includes(id))) continue;
          const target = state.units.filter((u) => u.side === "enemy" && !u.down).sort((a, b) => hexDistance(a.pos, me.pos) - hexDistance(b.pos, me.pos))[0];
          if (!target) continue;
          const ability = me.abilities[0];
          let tried = stepZone(state, { type: "use", by: id, unit: id, ability, target: target.id });
          if (!tried.ok) {
            // Walk as near as the turn allows.
            const reach = zoneReach(state, me, fighting ? moveLeft(state.encounter!.budgets[id]) : 12);
            const spot = [...reach.values()].filter((r) => r.stop).sort((a, b) => hexDistance(a.pos, target.pos) - hexDistance(b.pos, target.pos) || a.cost - b.cost)[0];
            if (spot && hexDistance(spot.pos, target.pos) < hexDistance(me.pos, target.pos)) state = must(state, { type: "move", by: id, unit: id, to: spot.pos }, events);
            tried = stepZone(state, { type: "use", by: id, unit: id, ability, target: target.id });
          }
          if (tried.ok) {
            state = tried.state;
            events.push(...tried.events);
          }
          check();
          if (state.encounter?.acting.includes(id) && !state.encounter.done.includes(id)) state = must(state, { type: "end_turn", by: id, unit: id }, events);
          check();
        }
        if (state.encounter && !state.encounter.acting.some((id) => !state.encounter!.done.includes(id))) state = must(state, { type: "timeout" }, events);
      }
      // Either the map is cleared or it ran long; either way the state is whole.
      check();
      // No enemy walked further in a turn of its own than its two AP of movement would take it (being shoved about is not walking).
      let turn: string | null = null;
      let steps = 0;
      for (const e of events) {
        if (e.t === "turn") [turn, steps] = [e.ids[0] ?? null, 0];
        else if (e.t === "moved" && e.id === turn && !["ann", "bo"].includes(e.id)) {
          steps += e.path.length;
          expect(steps, `seed ${seed}: ${kinds.get(e.id)} ${e.id}`).toBeLessThanOrEqual(ENEMY_MOVE_AP * enemyMove(kinds.get(e.id)!));
        }
        if (e.t === "used" && e.what === "attack" && !["ann", "bo"].includes(e.id)) struck += 1;
      }
    }
    // And for all that they do not go far, they still get their blows in.
    expect(struck).toBeGreaterThan(20);
  }, 60_000);
});

// ---------- fleeing ----------

describe("a dead enemy's hex", () => {
  /** Ann in a fight with two bandits, AI off, on her turn. The one beside her has just died where it stood; the other is far off. */
  function overTheBody() {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(4, 6));
    const dead = enemy(state, "bandit", at(5, 6));
    const other = enemy(state, "bandit", at(12, 2));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    Object.assign(unit(state, dead.id), { hp: 0, down: true });
    return { state, dead: dead.id, other: other.id };
  }

  it("is free the moment it dies, with the fight still on: it is walked onto and walked through", () => {
    const { state, dead } = overTheBody();
    expect(state.encounter).not.toBeNull();
    // The body is still there (it is cleared when the fight ends), and it is in nobody's way.
    expect(unit(state, dead)).toMatchObject({ down: true, pos: at(5, 6) });
    expect(zoneReach(state, unit(state, "ann"), moveLeft(state.encounter!.budgets.ann)).get(posKey(at(5, 6)))).toMatchObject({ cost: 1, stop: true });
    // Onto it: she stops there, and is not shuffled off it.
    const onto: ZoneEvent[] = [];
    const stood = must(state, { type: "move", by: "ann", unit: "ann", to: at(5, 6) }, onto);
    expect(unit(stood, "ann").pos).toEqual(at(5, 6));
    expect(onto.filter((e) => e.t === "moved")).toEqual([{ t: "moved", id: "ann", path: [at(5, 6)] }]);
    // Through it: the straight way to the hex beyond.
    const through: ZoneEvent[] = [];
    const past = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }, through);
    expect(unit(past, "ann").pos).toEqual(at(6, 6));
    expect(through.filter((e) => e.t === "moved")).toEqual([{ t: "moved", id: "ann", path: [at(5, 6), at(6, 6)] }]);
  });

  it("can be jumped onto, and an enemy can be shoved onto it", () => {
    const { state } = overTheBody();
    const jumped = must(state, { type: "common", by: "ann", unit: "ann", what: "jump", at: at(5, 6) });
    expect(unit(jumped, "ann").pos).toEqual(at(5, 6));
    // A dummy between her and a body: shoved, it lands on the body's hex instead of being knocked down where it stands.
    const shoved = board();
    shoved.aiOff = true;
    hero(shoved, "ann", "qa_paladin", at(4, 6));
    const foe = enemy(shoved, "dummy", at(5, 6));
    Object.assign(enemy(shoved, "bandit", at(6, 6)), { hp: 0, down: true });
    let pushed: ZoneState | null = null;
    for (let seed = 1; seed < 40 && !pushed; seed++) {
      const step = stepZone({ ...shoved, rng: seed }, { type: "common", by: "ann", unit: "ann", what: "shove", target: foe.id });
      if (step.ok && step.events.some((e) => e.t === "shoved")) pushed = step.state;
    }
    expect(pushed).not.toBeNull();
    expect(unit(pushed!, foe.id).pos).toEqual(at(6, 6));
    expect(unit(pushed!, foe.id).conditions.some((c) => c.kind === "prone")).toBe(false);
  });

  it("is the only one that takes up no room: an enemy on its feet bars the way, and a fallen hero keeps their place on their hex", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(4, 6));
    hero(state, "bo", "qa_paladin", at(4, 8));
    hero(state, "cy", "qa_paladin", at(4, 8));
    hero(state, "di", "qa_paladin", at(6, 8));
    const foe = enemy(state, "bandit", at(5, 6));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    for (const id of ["bo", "di"]) Object.assign(unit(state, id), { hp: 0, down: true });
    const reach = zoneReach(state, unit(state, "ann"), 10);
    // The bandit bars the way: its hex is nowhere she can go, however much movement she has.
    expect(reach.has(posKey(unit(state, foe.id).pos))).toBe(false);
    expect(stepCost(state, unit(state, "ann"), at(4, 6), at(5, 6))).toEqual({ cost: Infinity, stop: false });
    // Bo is down, but still there: with Cy standing over them the hex is full. It is walked through, and not stopped on or landed on.
    expect(reach.get(posKey(at(4, 8)))).toMatchObject({ stop: false });
    expect(reach.get(posKey(at(4, 9)))).toBeDefined();
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(4, 8) })).toMatch(/standing there/);
    expect(fails(state, { type: "common", by: "ann", unit: "ann", what: "jump", at: at(4, 8) })).toMatch(/nowhere to land/);
    // Di lies alone on theirs: one more can stand there, and a friend lying there costs nothing to step over.
    expect(reach.get(posKey(at(6, 8)))).toMatchObject({ stop: true });
    expect(stepCost(state, unit(state, "ann"), at(5, 8), at(6, 8))).toEqual({ cost: 1, stop: true });
    expect(unitAt(state, at(6, 8))?.id).toBe("di");
    expect(unitAt(state, at(4, 8))?.id).toBe("cy");
    // To the bandit, Di lying there is as much in the way as Cy on their feet: a hero who is down is not dead.
    expect(stepCost(state, unit(state, foe.id), at(5, 8), at(6, 8))).toEqual({ cost: Infinity, stop: false });
    expect(stepCost(state, unit(state, foe.id), at(5, 8), at(4, 8))).toEqual({ cost: Infinity, stop: false });
  });

  it("is given back to it if the fight is lost, unless someone not in the fight stands there: then it takes the nearest free hex", () => {
    let { state, dead, other } = overTheBody();
    // Bo, who is in no fight, has walked onto the body's hex (its post); Ann falls to the other bandit.
    hero(state, "bo", "qa_paladin", at(5, 6));
    unit(state, other).pos = at(13, 3);
    Object.assign(unit(state, "ann"), { hp: 0, down: true });
    const events: ZoneEvent[] = [];
    state = must(state, { type: "timeout" }, events);
    expect(events).toContainEqual({ t: "fight_end", outcome: "defeat" });
    expect(state.encounter).toBeNull();
    expect(unit(state, "bo").pos).toEqual(at(5, 6));
    expect(unit(state, dead)).toMatchObject({ down: false, hp: unit(state, dead).maxHp });
    expect(hexDistance(unit(state, dead).pos, at(5, 6))).toBe(1);
    expect(unit(state, other)).toMatchObject({ pos: at(12, 2), hp: unit(state, other).maxHp });
    expect(new Set(state.units.map((u) => posKey(u.pos))).size).toBe(state.units.length);
  });
});

describe("fleeing", () => {
  const flee = (id = "ann"): ZoneAction => ({ type: "common", by: id, unit: id, what: "flee" });
  /** Ann and Bo in a fight with a wolf, AI off, and it is Ann's turn. */
  function pair(annClass = "qa_paladin") {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", annClass, at(3, 6));
    hero(state, "bo", "qa_paladin", at(3, 8));
    const wolf = enemy(state, "wolf", at(9, 6));
    state = provoke(state);
    expect(new Set(state.encounter!.order)).toEqual(new Set(["ann", "bo", wolf.id]));
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    return { state, wolf: wolf.id };
  }

  it("is for a fight, on your turn, once no enemy in it is within 2 hexes, and costs the Action (a Rogue's Bonus action)", () => {
    const alone = board();
    hero(alone, "ann", "qa_paladin", at(3, 6));
    expect(fails(alone, flee())).toMatch(/for a fight/);
    // Two hexes off: too close.
    const { state: near } = duel("bandit", "qa_paladin", at(5, 6), at(8, 6));
    expect(hexDistance(unit(near, "ann").pos, near.units.find((u) => u.side === "enemy")!.pos)).toBe(FLEE_RANGE);
    expect(fails(near, flee())).toMatch(/too close to get away/);
    // Clear of it, but the Action is gone.
    const { state: clear } = duel("bandit", "qa_paladin", at(3, 6), at(9, 6));
    clear.encounter!.budgets.ann.ap = 1;
    expect(fails(clear, flee())).toMatch(/takes 2 AP/);
    // A Rogue runs for 1 AP.
    expect(commonCost("flee", "refactor_rogue")).toBe(BONUS_AP);
    const { state: rogue } = duel("bandit", "refactor_rogue", at(3, 6), at(9, 6));
    rogue.encounter!.budgets.ann.ap = 1;
    expect(stepZone(rogue, flee()).ok).toBe(true);
  });

  it("ends the fight with nobody winning when the last hero gets away: nothing paid, nobody moved, the enemy home and whole again", () => {
    let { state, foe } = duel("bandit", "qa_paladin", at(3, 6), at(9, 6));
    const bandit = unit(state, foe);
    bandit.hp -= 4;
    bandit.conditions.push({ kind: "bleeding", rounds: 3 });
    bandit.pos = at(7, 6);
    unit(state, "ann").hp -= 3;
    unit(state, "ann").cooldowns = { bash: 2 };
    const before = structuredClone(unit(state, "ann"));
    const step = stepZone(state, flee());
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    expect(step.events).toContainEqual({ t: "used", id: "ann", what: "flee", name: "Flee", target: undefined, at: undefined });
    expect(step.events).toContainEqual({ t: "fled", id: "ann" });
    expect(step.events).toContainEqual({ t: "fight_end", outcome: "fled" });
    expect(step.events.some((e) => e.t === "spoils" || e.t === "cleared")).toBe(false);
    expect(step.effects).toEqual([]);
    expect(state.encounter).toBeNull();
    // No worse off than losing: where she stood, as hurt as she was, never knocked down to 1 HP.
    expect(unit(state, "ann")).toMatchObject({ pos: before.pos, hp: before.hp, down: false, cooldowns: {} });
    // The bandit is back at its post with its wounds bound, so fleeing is no way to wear it down, and has stopped looking.
    expect(unit(state, foe)).toMatchObject({ pos: at(9, 6), hp: bandit.maxHp, down: false, conditions: [] });
    expect(state.groups.g1.alerted).toBe(false);
    // She walks free, and walking right up to it again starts a new fight.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(state.encounter).toBeNull();
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 6) });
    expect(state.encounter?.order).toContain(foe);
  });

  it("goes on for whoever is still in it, and draws the one who fled back only when an enemy in it is within 2 hexes", () => {
    let { state, wolf } = pair();
    state = must(state, flee());
    expect(state.encounter).not.toBeNull();
    expect(state.encounter!.order).toEqual(expect.arrayContaining(["bo", wolf]));
    expect(state.encounter!.order).not.toContain("ann");
    expect(state.encounter!.fled).toEqual(["ann"]);
    // Walking is free again, and well inside JOIN_RANGE of the fight she stays out of it.
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(unit(state, "ann").pos).toEqual(at(6, 6));
    expect(state.encounter!.order).not.toContain("ann");
    // Within 2 of the wolf: back in, and stopped there.
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 6) }, events);
    expect(events).toContainEqual({ t: "fight_join", id: "ann" });
    expect(hexDistance(unit(state, "ann").pos, unit(state, wolf).pos)).toBe(FLEE_RANGE);
    expect(state.encounter!.order).toContain("ann");
    expect(state.encounter!.fled).toEqual([]);
  });

  it("draws a hero who fled back in when an enemy in the fight comes within 2 hexes of them", () => {
    let { state, wolf } = pair();
    state = must(state, flee());
    // The wolf, after Bo, comes past her.
    state.units.find((u) => u.id === wolf)!.pos = at(5, 6);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "time", now: 1 }, events);
    expect(events).toContainEqual({ t: "fight_join", id: "ann" });
    expect(state.encounter!.order).toContain("ann");
  });

  it("keeps a hero who fled from reaching back into the fight from outside it, but not from looking after themselves", () => {
    const { state: start, wolf } = pair("devops_mage");
    const out = must(start, flee());
    // Sturdy enough to outlast a shock, so the fight is still on to be in.
    Object.assign(unit(out, wolf), { hp: 200, maxHp: 200 });
    // Out of the fight there is no Action to spend and no cooldown running: a blow, a heal or a flask for anyone in
    // it would come free and off the turn order, every time they fled. They go back to it instead.
    expect(fails(out, { type: "use", by: "ann", unit: "ann", ability: "shock", target: wolf })).toMatch(/got away from that fight/);
    expect(fails(out, { type: "use", by: "ann", unit: "ann", ability: "mend", target: "bo" })).toMatch(/got away from that fight/);
    expect(fails(out, { type: "throw", by: "ann", unit: "ann", item: "healing", at: unit(out, "bo").pos })).toMatch(/got away from that fight/);
    const self = must(out, { type: "use", by: "ann", unit: "ann", ability: "mend", target: "ann" });
    expect(self.encounter!.order).not.toContain("ann");
    // A hero who never was in it, shooting in from further off than JOIN_RANGE, is in it too.
    let far = board();
    far.aiOff = true;
    hero(far, "ann", "qa_paladin", at(3, 2));
    const archer = hero(far, "cy", "refactor_rogue", at(12, 2));
    const foe = enemy(far, "bandit", at(5, 2));
    Object.assign(foe, { hp: 200, maxHp: 200 });
    far = provoke(far);
    expect(far.encounter!.order).not.toContain(archer.id);
    expect(Math.min(hexDistance(archer.pos, foe.pos), hexDistance(archer.pos, at(3, 2)))).toBeGreaterThan(JOIN_RANGE);
    far = must(far, { type: "use", by: "cy", unit: "cy", ability: "bow_shot", target: foe.id });
    expect(far.encounter!.order).toContain("cy");
  });

  /**
   * Bo and Ann sharing a turn, Bo first and Ann last of the two, the wolf after them, AI off: the order set out by
   * hand so it is the same every time.
   */
  function shared() {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    hero(state, "bo", "qa_paladin", at(3, 9));
    const wolf = enemy(state, "wolf", at(9, 6)).id;
    state = provoke(state);
    const fresh = { ap: AP_TURN, move: 5, stride: 2, disengaged: false };
    Object.assign(state.encounter!, { order: ["bo", "ann", wolf], init: { bo: 20, ann: 15, [wolf]: 5 }, acting: ["bo", "ann"], done: [], budgets: { bo: { ...fresh }, ann: { ...fresh } } });
    return { state, wolf };
  }

  it("brings one who fled back in the place they had, to wait for the next round: no second turn out of it", () => {
    let { state, wolf } = shared();
    const { round } = state.encounter!;
    state = must(state, flee());
    expect(state.encounter!.acting).toEqual(["bo"]);
    expect(state.encounter!.waits).toEqual(["ann"]);
    // Straight back within 2 of the wolf, while Bo still has the turn: in again, with no fresh roll for it.
    const events: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(8, 6) }, events);
    expect(hexDistance(unit(state, "ann").pos, unit(state, wolf).pos)).toBe(FLEE_RANGE);
    expect(events.some((e) => e.t === "roll")).toBe(false);
    expect(state.encounter!.init.ann).toBe(15);
    expect(state.encounter!.order).toEqual(["bo", "ann", wolf]);
    // Bo ends the turn: next in the order is Ann, but she has had this round's. The wolf goes, then a new round.
    state = must(state, { type: "end_turn", by: "bo", unit: "bo" });
    expect(state.encounter!.round).toBe(round + 1);
    expect(state.encounter!.acting).toEqual(["bo", "ann"]);
    expect(state.encounter!.waits).toBeUndefined();
  });

  it("still burns, and runs down what is on them, while a hero who fled is out of a fight that goes on", () => {
    let { state } = shared();
    unit(state, "ann").conditions.push({ kind: "burning", rounds: 3 }, { kind: "slowed", rounds: 2 });
    state = must(state, flee());
    const hp = unit(state, "ann").hp;
    // A round of the fight goes by (Bo ends the turn, the wolf does nothing): the same as a round out of one.
    state = must(state, { type: "end_turn", by: "bo", unit: "bo" });
    expect(state.encounter).not.toBeNull();
    expect(state.encounter!.order).not.toContain("ann");
    expect(unit(state, "ann").hp).toBeLessThan(hp);
    expect(unit(state, "ann").conditions.find((c) => c.kind === "slowed")?.rounds ?? 0).toBeLessThan(2);
  });

  it("hands the turn on to whoever came after a hero who fled on a turn of their own", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    hero(state, "bo", "qa_paladin", at(3, 9));
    const a = enemy(state, "wolf", at(9, 6));
    const b = enemy(state, "wolf", at(9, 9));
    state = provoke(state);
    const turnOf = (order: string[]) => {
      const s = structuredClone(state);
      Object.assign(s.encounter!, { order, acting: ["ann"], done: [], budgets: { ann: { ap: AP_TURN, move: 5, stride: 2, disengaged: false } } });
      return s;
    };
    const { round, turnNo } = state.encounter!;
    // In the middle of the round: the wolf after her goes next (and does nothing, with the AI off), then Bo.
    const mid = must(turnOf([a.id, "ann", b.id, "bo"]), flee());
    expect(mid.encounter).toMatchObject({ round, turnNo: turnNo + 2, acting: ["bo"], order: [a.id, b.id, "bo"] });
    expect(mid.encounter!.resume).toBeUndefined();
    // Last in the order: a new round, from the top.
    const last = must(turnOf([a.id, "bo", b.id, "ann"]), flee());
    expect(last.encounter).toMatchObject({ round: round + 1, turnNo: turnNo + 2, acting: ["bo"] });
    // Sharing a turn with Bo: it is still Bo's.
    const sharing = turnOf([a.id, "ann", "bo", b.id]);
    sharing.encounter!.acting = ["ann", "bo"];
    sharing.encounter!.budgets.bo = { ap: AP_TURN, move: 5, stride: 2, disengaged: false };
    const after = must(sharing, flee());
    expect(after.encounter).toMatchObject({ turnNo, acting: ["bo"], done: [] });
  });

  it("leaves the fight lost for the fallen when the last hero standing gets away from them", () => {
    let { state, wolf } = pair();
    unit(state, "bo").down = true;
    unit(state, "bo").hp = 0;
    unit(state, wolf).hp -= 3;
    const annBefore = structuredClone(unit(state, "ann"));
    const events: ZoneEvent[] = [];
    state = must(state, flee(), events);
    expect(events).toContainEqual({ t: "fight_end", outcome: "defeat" });
    expect(state.encounter).toBeNull();
    // The fallen wake at the start, as from any lost fight; the one who ran is where she ran to.
    expect(unit(state, "bo")).toMatchObject({ down: false, hp: 1 });
    expect(hexDistance(unit(state, "bo").pos, state.start)).toBeLessThanOrEqual(1);
    expect(unit(state, "ann")).toMatchObject({ pos: annBefore.pos, hp: annBefore.hp });
    expect(unit(state, wolf)).toMatchObject({ hp: unit(state, wolf).maxHp, pos: at(9, 6) });
  });

  it("leaves the enemy who fell fallen, heals the rest, and finds a post taken by a hero the nearest free hex", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    const fallen = enemy(state, "bandit", at(9, 6));
    const other = enemy(state, "bandit", at(9, 4));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    Object.assign(unit(state, fallen.id), { hp: 0, down: true });
    // The other has come out to her: she has got round it to stand on its post.
    unit(state, other.id).pos = at(5, 3);
    unit(state, other.id).hp = 2;
    unit(state, "ann").pos = at(9, 4);
    const step = stepZone(state, flee());
    if (!step.ok) throw new Error(step.error);
    expect(step.effects).toEqual([]);
    expect(step.state.units.some((u) => u.id === fallen.id)).toBe(false);
    const back = step.state.units.find((u) => u.id === other.id)!;
    expect(hexDistance(back.pos, at(9, 4))).toBe(1);
    expect(back.hp).toBe(back.maxHp);
    expect(unit(step.state, "ann").pos).toEqual(at(9, 4));
  });

  it("draws nobody whose player has left into a fight, nor lets its blows land on them, until they come back", () => {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "qa_paladin", at(3, 6));
    hero(state, "bo", "qa_paladin", at(3, 8));
    const mate = hero(state, "s1", "devops_mage", at(2, 9));
    mate.controller = "bo";
    const ogre = enemy(state, "ogre", at(4, 7));
    expect([hexDistance(ogre.pos, at(3, 6)), hexDistance(ogre.pos, at(3, 8))]).toEqual([ENEMY_BURST, ENEMY_BURST]);
    // Bo has gone, and the stand-in Bo plays with him.
    state = must(state, { type: "away", player: "bo", away: true });
    expect([unit(state, "bo").away, unit(state, "s1").away, unit(state, "ann").away]).toEqual([true, true, undefined]);
    state = provoke(state);
    expect(state.encounter!.order).toEqual(expect.arrayContaining(["ann", ogre.id]));
    expect(state.encounter!.order).not.toContain("bo");
    expect(state.encounter!.order).not.toContain("s1");
    // The ogre stamps the ground: Ann, in the fight, is caught; Bo, beside her and not in it, is not.
    const stomp = enemyStrikes("ogre", 1).find((s) => s.burst)!;
    const events: ZoneEvent[] = [];
    const ctx: Ctx = { state: structuredClone(state), rng: makeRng(3), events, effects: [] };
    enemyAct(ctx, unit(ctx.state, ogre.id), stomp, null);
    expect(events.some((e) => (e.t === "hit" || e.t === "roll") && ("target" in e ? e.target === "ann" : e.roll.id === "ann"))).toBe(true);
    expect(events.some((e) => (e.t === "hit" && e.target === "bo") || (e.t === "roll" && e.roll.id === "bo"))).toBe(false);
    // He comes back: he is here again, and near the fight he is in it.
    const back: ZoneEvent[] = [];
    state = must(state, { type: "join", hero: standInHero("qa_paladin", "bo", 1)! }, back);
    expect(unit(state, "bo").away).toBeUndefined();
    expect(unit(state, "s1").away).toBeUndefined();
    expect(back).toContainEqual({ t: "fight_join", id: "bo" });
    expect(state.encounter!.order).toContain("s1");
  });

  it("brings a hero's class abilities with them, after the weapon's, and refreshes them on a return", () => {
    const sheet = standInHero("qa_paladin", "cy", 3)!;
    let state = must(board(), { type: "join", hero: { ...sheet, classAbilities: ["shock", "bash"] } });
    const weapon = abilitiesFor(sheet.weapon);
    expect(unit(state, "cy").abilities).toEqual([...new Set([...weapon, "shock", "bash"])]);
    state = must(state, { type: "join", hero: { ...sheet, classAbilities: [] } });
    expect(unit(state, "cy").abilities).toEqual(weapon);
  });

  it("keeps a hero whose player leaves in the middle of a fight in it", () => {
    let { state } = pair();
    state = must(state, { type: "away", player: "ann", away: true });
    expect(state.encounter!.order).toContain("ann");
  });

  it("keeps its own rules through whole fights where heroes run off and get caught again", () => {
    let ran = 0;
    for (let seed = 0; seed < 8; seed++) {
      let state = createZone("RUN", `run-${seed}`, zoneOptions({ size: "small", biome: (["meadow", "caves"] as const)[seed % 2], groups: 2, party: 2, clear: 3, obstacles: 1, elevation: 1, threat: 1 }));
      state = must(state, { type: "join", hero: standInHero("refactor_rogue", "ann", 3)! });
      state = must(state, { type: "join", hero: standInHero("qa_paladin", "bo", 3)! });
      const dice = makeRng(seed + 1);
      const check = () => {
        const where = `seed ${seed}`;
        // No hex holds more than it has room for (the dead take up none), and none holds fighters of both sides.
        const crowd = new Map<string, number>();
        const sides = new Map<string, Set<string>>();
        for (const u of state.units) {
          if (isDead(u)) continue;
          crowd.set(posKey(u.pos), (crowd.get(posKey(u.pos)) ?? 0) + 1);
          sides.set(posKey(u.pos), (sides.get(posKey(u.pos)) ?? new Set()).add(u.side));
        }
        expect(Math.max(...crowd.values()), where).toBeLessThanOrEqual(HEX_ROOM);
        expect(Math.max(...[...sides.values()].map((s) => s.size)), where).toBe(1);
        const enc = state.encounter;
        if (!enc) return;
        // A turn is one fighter's alone.
        expect(enc.acting.length, where).toBeLessThanOrEqual(1);
        for (const id of enc.acting) expect(enc.order, where).toContain(id);
        for (const id of enc.fled ?? []) expect(enc.order, where).not.toContain(id);
        expect(enc.resume, where).toBeUndefined();
        expect(enc.order.some((id) => unit(state, id).side === "hero"), where).toBe(true);
      };
      for (let step = 0; step < 150; step++) {
        if (!state.units.some((u) => u.side === "enemy" && !u.down)) break;
        for (const id of ["ann", "bo"]) {
          const me = unit(state, id);
          if (me.down) continue;
          const enc = state.encounter;
          const fighting = !!enc?.order.includes(id);
          if (fighting && (!enc!.acting.includes(id) || enc!.done.includes(id))) continue;
          const foes = state.units.filter((u) => u.side === "enemy" && !u.down && (!fighting || enc!.order.includes(u.id)));
          if (fighting && dice.int(1, 3) === 1) {
            // Run: as far from them as this turn goes (blows and all), then off, if that got clear.
            const reach = zoneReach(state, me, moveLeft(enc!.budgets[id]));
            const far = (p: HexPos) => Math.min(...foes.map((f) => hexDistance(f.pos, p)));
            const spot = [...reach.values()].filter((r) => r.stop).sort((a, b) => far(b.pos) - far(a.pos))[0];
            if (spot && spot.cost > 0) state = must(state, { type: "move", by: id, unit: id, to: spot.pos });
            check();
            const out = stepZone(state, flee(id));
            if (out.ok) {
              state = out.state;
              ran += 1;
              check();
              continue;
            }
            if (unit(state, id).down || !state.encounter?.budgets[id]) continue;
          }
          const now = unit(state, id);
          const target = foes.sort((a, b) => hexDistance(a.pos, now.pos) - hexDistance(b.pos, now.pos))[0];
          if (!target) continue;
          const ability = now.abilities[0];
          let tried = stepZone(state, { type: "use", by: id, unit: id, ability, target: target.id });
          if (!tried.ok) {
            const me = now;
            const reach = zoneReach(state, me, state.encounter?.order.includes(id) ? (state.encounter.budgets[id]?.move ?? 0) : 12);
            const spot = [...reach.values()].filter((r) => r.stop).sort((a, b) => hexDistance(a.pos, target.pos) - hexDistance(b.pos, target.pos) || a.cost - b.cost)[0];
            if (spot && hexDistance(spot.pos, target.pos) < hexDistance(me.pos, target.pos)) state = must(state, { type: "move", by: id, unit: id, to: spot.pos });
            tried = stepZone(state, { type: "use", by: id, unit: id, ability, target: target.id });
          }
          if (tried.ok) state = tried.state;
          check();
          if (state.encounter?.acting.includes(id) && !state.encounter.done.includes(id)) state = must(state, { type: "end_turn", by: id, unit: id });
          check();
        }
        if (state.encounter && !state.encounter.acting.some((id) => !state.encounter!.done.includes(id))) state = must(state, { type: "timeout" });
        check();
      }
    }
    expect(ran).toBeGreaterThan(0);
  }, 60_000);
});

// ---------- a delve ----------

describe("a delve", () => {
  const delveOptions = (party = 2) => zoneOptions({ biome: "caves", delve: true, party, level: 3 });
  /** Every open hex walkable from the mouth. */
  const fromMouth = (state: ZoneState) => {
    // A locked door can be opened, so the way through it counts.
    const open = new Set(state.map.tiles.filter((t) => !solid(t) || t.biome === "gate").map((t) => posKey(t)));
    const seen = new Set([posKey(state.start)]);
    const queue = [state.start];
    for (let i = 0; i < queue.length; i++) {
      for (const n of hexNeighbors(queue[i], state.map.grid)) {
        if (!open.has(posKey(n)) || seen.has(posKey(n))) continue;
        seen.add(posKey(n));
        queue.push(n);
      }
    }
    return seen;
  };
  const tileOf = (state: ZoneState, p: HexPos) => state.map.tiles.find((t) => t.q === p.q && t.r === p.r);

  it("is the caverns' own layout: chambers and tunnels from the mouth, its bands as groups, and chests to open", () => {
    for (let seed = 0; seed < 12; seed++) {
      const where = `seed ${seed}`;
      const plan = generateDelve(`d${seed}`, delveOptions());
      expect(generateDelve(`d${seed}`, delveOptions()), where).toEqual(plan);
      // Every locked door is a door to work, standing where the caverns put it.
      const gates = plan.map.tiles.filter((t) => t.biome === "gate");
      expect(plan.map.pois.filter((p) => p.kind === "gate").map((p) => posKey(p.pos)).sort(), where).toEqual(gates.map((t) => posKey(t)).sort());
      expect(plan.map.pois.filter((p) => p.kind === "landing").map((p) => p.pos), where).toEqual([plan.start]);
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      const reach = fromMouth(state);
      // Every band stands where the party can walk to it, under its chamber's name; every chest can be reached.
      for (const u of state.units) expect(reach.has(posKey(u.pos)), where).toBe(true);
      expect(Object.keys(state.groups).length, where).toBeGreaterThanOrEqual(2);
      for (const id of Object.keys(state.groups)) expect(id, where).toMatch(/^(band\d+|lair)$/);
      const caches = state.map.pois.filter((p) => p.kind === "cache");
      expect(caches.length, where).toBeGreaterThan(0);
      for (const c of caches) expect([...hexNeighbors(c.pos, state.map.grid), c.pos].some((n) => reach.has(posKey(n))), where).toBe(true);
      // The hoard is there, guarded by the haunt.
      const hoard = caches.find((c) => c.loot === "hoard");
      if (hoard) {
        expect(hoard.guard, where).toBe("lair");
        expect(state.units.some((u) => u.group === "lair" && u.kind === "haunt"), where).toBe(true);
      }
      // Nobody stands on the mouth, so the party always has room to arrive.
      expect(state.units.some((u) => posKey(u.pos) === posKey(state.start)), where).toBe(false);
    }
  });

  it("lets daylight in at the mouth: the hexes round it are lit with no torch", () => {
    const state = createZone("DLVE", "d2", delveOptions());
    const lit = litHexes(state)!;
    expect(lit.has(posKey(state.start))).toBe(true);
    for (const n of hexNeighbors(state.start, state.map.grid)) if (!solid(state.map.tiles.find((t) => t.q === n.q && t.r === n.r))) expect(lit.has(posKey(n))).toBe(true);
    // Far down the tunnels it is still dark.
    expect(state.map.tiles.some((t) => t.biome === "cave" && !lit.has(posKey(t)))).toBe(true);
  });

  /** A delve seed with a locked door, and a hero standing beside it with nobody else about. */
  const atDoor = () => {
    for (let seed = 0; seed < 60; seed++) {
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      const door = state.map.pois.find((p) => p.kind === "gate");
      if (!door) continue;
      const beside = hexNeighbors(door.pos, state.map.grid).find((n) => tileOf(state, n)?.biome === "cave" && !state.units.some((u) => posKey(u.pos) === posKey(n)));
      if (!beside) continue;
      return { state, door, beside, seed };
    }
    throw new Error("no delve with a door in sixty seeds");
  };

  it("shuts a room or two behind a locked door: a wall that blocks the way and the view until it opens", () => {
    let doors = 0;
    for (let seed = 0; seed < 30; seed++) {
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      for (const door of state.map.pois.filter((p) => p.kind === "gate")) {
        doors++;
        expect(solid(tileOf(state, door.pos))).toBe(true);
        expect(door.cleared).toBe(false);
      }
    }
    expect(doors).toBeGreaterThan(0);
  });

  it("unlocks a door quietly with a key off the ring, and uses the key up", () => {
    const { state, door, beside } = atDoor();
    hero(state, "ann", "qa_paladin", beside);
    expect(fails(state, { type: "unlock", by: "ann", unit: "ann", poi: "gate99" })).toMatch(/no door/);
    state.keys = 1;
    const events: ZoneEvent[] = [];
    const next = must(state, { type: "unlock", by: "ann", unit: "ann", poi: door.id }, events);
    expect(next.keys).toBe(0);
    expect(next.map.pois.find((p) => p.id === door.id)!.cleared).toBe(true);
    expect(tileOf(next, door.pos)!.biome).toBe("cave");
    expect(events).toContainEqual({ t: "door", id: "ann", poi: door.id, how: "key" });
    expect(events.some((e) => e.t === "noise" || e.t === "roll")).toBe(false);
    expect(fails(next, { type: "unlock", by: "ann", unit: "ann", poi: door.id })).toMatch(/open already/);
  });

  it("forces a door without a key on a Strength roll, and the crash brings the nearest band that has not noticed anyone", () => {
    let held = false;
    let forced = false;
    for (let rng = 1; rng < 80 && !(held && forced); rng++) {
      const { state, door, beside } = atDoor();
      state.rng = rng;
      hero(state, "ann", "qa_paladin", beside);
      const near = state.units.filter((u) => u.side === "enemy" && hexDistance(u.pos, door.pos) <= NOISE_RANGE);
      const events: ZoneEvent[] = [];
      const step = stepZone(state, { type: "unlock", by: "ann", unit: "ann", poi: door.id });
      if (!step.ok) throw new Error(step.error);
      events.push(...step.events);
      const roll = events.find((e) => e.t === "roll" && e.roll.kind === "save");
      expect(roll).toBeDefined();
      const ok = roll!.t === "roll" && roll!.roll.ok;
      expect(step.state.map.pois.find((p) => p.id === door.id)!.cleared).toBe(ok);
      expect(events).toContainEqual({ t: "door", id: "ann", poi: door.id, how: ok ? "forced" : "held" });
      // Heard either way, if a band is near enough.
      expect(events.some((e) => e.t === "noise")).toBe(near.length > 0);
      if (near.length > 0) expect(step.state.encounter).not.toBeNull();
      if (ok) forced = true;
      else held = true;
    }
    expect(forced && held).toBe(true);
  });

  it("puts a key on the ring from a chest that holds one, and from a band that carried one once it is beaten", () => {
    for (let seed = 0; seed < 60; seed++) {
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      const keyChest = state.map.pois.find((p) => p.kind === "cache" && p.key);
      const band = state.keyHolders?.[0];
      if (!keyChest && !band) continue;
      if (keyChest) {
        state.units = state.units.filter((u) => u.side === "hero" || (u.group !== keyChest.guard && hexDistance(u.pos, keyChest.pos) > 3));
        const beside = hexNeighbors(keyChest.pos, state.map.grid).find((n) => tileOf(state, n)?.biome === "cave")!;
        hero(state, "ann", "qa_paladin", beside);
        const events: ZoneEvent[] = [];
        const next = must(state, { type: "open", by: "ann", unit: "ann", poi: keyChest.id }, events);
        expect(next.keys).toBe(1);
        expect(events).toContainEqual({ t: "key", keys: 1, from: "chest", id: "ann" });
      }
      if (band) {
        const fresh = createZone("DLVE", `d${seed}`, delveOptions());
        const one = fresh.units.find((u) => u.group === band)!;
        hero(fresh, "ann", "qa_paladin", hexNeighbors(one.pos, fresh.map.grid).find((n) => tileOf(fresh, n)?.biome === "cave" && !fresh.units.some((u) => posKey(u.pos) === posKey(n)))!);
        let s = must(fresh, { type: "dev", by: "ann", dev: { op: "start_fight" } });
        const events: ZoneEvent[] = [];
        s = must(s, { type: "dev", by: "ann", dev: { op: "end_fight" } }, events);
        if (!s.units.some((u) => u.group === band && !u.down)) {
          expect(s.keys).toBe(1);
          expect(events).toContainEqual({ t: "key", keys: 1, from: "band" });
          expect(s.keyHolders ?? []).not.toContain(band);
        }
      }
      return;
    }
    throw new Error("no delve with a key in sixty seeds");
  });

  it("sets out no chest or crate where it blocks the way up to a locked door", () => {
    let doors = 0;
    for (let seed = 0; seed < 60; seed++) {
      const state = createZone("DLVE", `d${seed}`, delveOptions());
      const things = new Set(state.map.pois.filter((p) => p.kind === "cache" || p.kind === "crate").map((p) => posKey(p.pos)));
      const seen = new Set([posKey(state.start)]);
      const queue = [state.start];
      for (let i = 0; i < queue.length; i++) {
        for (const n of hexNeighbors(queue[i], state.map.grid)) {
          if (seen.has(posKey(n)) || things.has(posKey(n)) || solid(tileOf(state, n))) continue;
          seen.add(posKey(n));
          queue.push(n);
        }
      }
      for (const door of state.map.pois.filter((p) => p.kind === "gate")) {
        doors++;
        // Some floor beside the door can be walked to from the mouth, round every chest and crate.
        expect(hexNeighbors(door.pos, state.map.grid).some((n) => seen.has(posKey(n))), `seed ${seed} ${door.id}`).toBe(true);
      }
    }
    expect(doors).toBeGreaterThan(0);
  });

  it("puts no chest where it shuts off any of the floor: one in the only way through is set aside in its chamber", () => {
    for (let seed = 0; seed < 60; seed++) {
      const where = `seed ${seed}`;
      const state = createZone("DLVE", `x${seed}`, delveOptions());
      const chests = state.map.pois.filter((p) => p.kind === "cache");
      const walk = (blocked: Set<string>) => {
        const seen = new Set([posKey(state.start)]);
        const queue = [state.start];
        for (let i = 0; i < queue.length; i++) {
          for (const n of hexNeighbors(queue[i], state.map.grid)) {
            if (seen.has(posKey(n)) || blocked.has(posKey(n)) || solid(tileOf(state, n))) continue;
            seen.add(posKey(n));
            queue.push(n);
          }
        }
        return seen;
      };
      const keys = new Set(chests.map((c) => posKey(c.pos)));
      const round = walk(keys);
      for (const key of walk(new Set())) if (!keys.has(key)) expect(round.has(key), `${where} ${key}`).toBe(true);
      expect(chests.some((c) => posKey(c.pos) === posKey(state.start)), where).toBe(false);
    }
  });

  it("gives a cave with no mouth one where heroes arrive, once, and leaves other maps alone", () => {
    const open = createZone("OPEN", "o1", zoneOptions({ biome: "caves", size: "small", groups: 1 }));
    expect(open.map.pois.filter((p) => p.kind === "landing").map((p) => p.pos)).toEqual([open.start]);
    // A cave saved before mouths were given out gets one as it is loaded, and only one however often.
    const old = structuredClone(open);
    old.map.pois = [];
    ensureMouth(ensureMouth(old));
    expect(old.map.pois.filter((p) => p.kind === "landing").map((p) => p.pos)).toEqual([old.start]);
    // A delve keeps the mouth it has; a meadow gets none.
    const delve = createZone("DLVE", "d1", delveOptions());
    expect(delve.map.pois.filter((p) => p.kind === "landing")).toHaveLength(1);
    expect(createZone("MEAD", "m1", zoneOptions({ biome: "meadow", size: "small" })).map.pois.some((p) => p.kind === "landing")).toBe(false);
  });

  it("grows a few clusters of glowing mushrooms against the rock, each lighting the dark round it until it is picked", () => {
    for (let seed = 0; seed < 12; seed++) {
      const where = `seed ${seed}`;
      const state = createZone("DLVE", `g${seed}`, delveOptions());
      const caps = state.map.pois.filter((p) => p.kind === "glowcap");
      expect(caps.length, where).toBeGreaterThanOrEqual(GLOWCAP_COUNT[0]);
      expect(caps.length, where).toBeLessThanOrEqual(GLOWCAP_COUNT[1]);
      const lit = litHexes(state)!;
      for (const c of caps) {
        expect(tileOf(state, c.pos)?.biome, where).toBe("cave");
        expect(state.map.pois.filter((p) => posKey(p.pos) === posKey(c.pos)), where).toHaveLength(1);
        expect(state.units.some((u) => posKey(u.pos) === posKey(c.pos)), where).toBe(false);
        expect(hexDistance(c.pos, state.start), where).toBeGreaterThan(2);
        expect(lit.has(posKey(c.pos)), where).toBe(true);
      }
      for (const a of caps) for (const b of caps) if (a !== b) expect(hexDistance(a.pos, b.pos), where).toBeGreaterThanOrEqual(4);
    }
  });

  it("lets a hero pick glowing mushrooms from beside them for a few mushrooms, once, and puts the glow out", () => {
    const state = createZone("DLVE", "g1", delveOptions());
    const cap = state.map.pois.find((p) => p.kind === "glowcap")!;
    state.units = state.units.filter((u) => u.side === "hero" || hexDistance(u.pos, cap.pos) > 4);
    // In a Diving Helm: the lantern helm would light the mushrooms too.
    hero(state, "ann", "qa_paladin", state.start).outfit = IN_A_DIVING_HELM;
    expect(fails(state, { type: "forage", by: "ann", unit: "ann", poi: cap.id })).toMatch(/Go up to them/);
    unit(state, "ann").pos = hexNeighbors(cap.pos, state.map.grid).find((n) => tileOf(state, n)?.biome === "cave" && !state.units.some((u) => posKey(u.pos) === posKey(n)))!;
    const step = stepZone(state, { type: "forage", by: "ann", unit: "ann", poi: cap.id });
    if (!step.ok) throw new Error(step.error);
    const grant = step.effects.find((e) => e.heroId === "ann")!;
    expect(grant.resources.mushrooms).toBeGreaterThanOrEqual(GLOWCAP_MUSHROOMS[0]);
    expect(grant.resources.mushrooms).toBeLessThanOrEqual(GLOWCAP_MUSHROOMS[1]);
    expect(step.events.some((e) => e.t === "spoils" && e.id === "ann" && e.resources.mushrooms === grant.resources.mushrooms)).toBe(true);
    expect(step.state.map.pois.find((p) => p.id === cap.id)!.cleared).toBe(true);
    // Picked, it lights nothing (unless something else does).
    const others = step.state.map.pois.filter((p) => (p.kind === "glowcap" && !p.cleared) || p.kind === "landing").some((p) => hexDistance(p.pos, cap.pos) <= 3);
    if (!others) expect(litHexes(step.state)!.has(posKey(cap.pos))).toBe(false);
    expect(fails(step.state, { type: "forage", by: "ann", unit: "ann", poi: cap.id })).toMatch(/Picked already/);
  });

  it("sends a lone hero against smaller bands, and the haunt alone", () => {
    const solo = createZone("DLVE", "d3", delveOptions(1));
    const crew = createZone("DLVE", "d3", delveOptions(4));
    expect(solo.units.length).toBeLessThan(crew.units.length);
    expect(solo.units.filter((u) => u.group === "lair").map((u) => u.kind)).toEqual(["haunt"]);
  });

  it("opens a chest from beside it once its guards are gone: its opener is paid its XP, and what is in it is theirs to take", () => {
    let state = createZone("DLVE", "d1", delveOptions());
    const chest = state.map.pois.find((p) => p.kind === "cache" && p.loot === "chest")!;
    expect(chest).toBeDefined();
    const ann = hero(state, "ann", "qa_paladin", state.start);
    expect(fails(state, { type: "open", by: "ann", unit: "ann", poi: chest.id })).toMatch(/Go up to it/);
    ann.pos = hexNeighbors(chest.pos, state.map.grid).find((n) => !solid(tileOf(state, n)) && !state.units.some((u) => posKey(u.pos) === posKey(n)))!;
    if (chest.guard) {
      expect(fails(state, { type: "open", by: "ann", unit: "ann", poi: chest.id })).toMatch(/guards still stand/);
      state.units = state.units.filter((u) => u.group !== chest.guard);
    }
    // Out of a fight, with nobody near enough to start one.
    state.units = state.units.filter((u) => u.side === "hero" || hexDistance(u.pos, ann.pos) > 3);
    const step = stepZone(state, { type: "open", by: "ann", unit: "ann", poi: chest.id });
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    expect(state.map.pois.find((p) => p.id === chest.id)!.cleared).toBe(true);
    expect(step.events).toContainEqual({ t: "opened", id: "ann", poi: chest.id, loot: "chest" });
    // Opening it pays its XP and nothing more.
    expect(step.effects).toEqual([{ type: "grant", heroId: "ann", xp: CHEST_PAY.chest.xp, resources: {} }]);
    expect(step.events).toContainEqual({ t: "spoils", id: "ann", xp: CHEST_PAY.chest.xp, resources: {} });
    // It stands open, and ann is looking into it: what is in it (for whoever takes it first) has been rolled.
    expect(step.events).toContainEqual({ t: "looked", id: "ann", spot: chest.id });
    const spot = state.loot!.find((s) => s.id === chest.id)!;
    expect(spot).toMatchObject({ kind: "chest", chest: "chest", pos: chest.pos });
    const mine = spot.shared!;
    const gold = mine.find((i) => i.t === "gold")!;
    expect(gold.t === "gold" && gold.n).toBeGreaterThanOrEqual(CHEST_PAY.chest.gold[0]);
    expect(gold.t === "gold" && gold.n).toBeLessThanOrEqual(CHEST_PAY.chest.gold[1]);
    expect(fails(state, { type: "open", by: "ann", unit: "ann", poi: chest.id })).toMatch(/stands open already/);
    // Taken, it is hers: the gold and the rest as a grant, and nothing left in it for anyone.
    const took = stepZone(state, { type: "take", by: "ann", unit: "ann", spot: chest.id });
    if (!took.ok) throw new Error(took.error);
    expect(took.events).toEqual([{ t: "took", id: "ann", spot: chest.id, items: mine }]);
    expect(took.effects[0]).toMatchObject({ type: "grant", heroId: "ann", xp: 0, gold: gold.t === "gold" ? gold.n : 0 });
    expect(took.state.loot!.find((s) => s.id === chest.id)!.shared).toEqual([]);
    expect(fails(took.state, { type: "take", by: "ann", unit: "ann", spot: chest.id })).toMatch(/nothing left in it/);
  });

  it("pays every player's hero on the map the hoard's XP, but no stand-in; what is in it goes to whoever takes it first, and no stand-in opens or searches it", () => {
    const state = createZone("DLVE", "d1", delveOptions());
    const hoard = state.map.pois.find((p) => p.loot === "hoard")!;
    expect(hoard).toBeDefined();
    state.units = state.units.filter((u) => u.side === "hero");
    const beside = hexNeighbors(hoard.pos, state.map.grid).filter((n) => !solid(tileOf(state, n)));
    hero(state, "ann", "qa_paladin", beside[0]);
    hero(state, "bo", "devops_mage", state.start);
    const helper = hero(state, "cy", "refactor_rogue", beside[1]);
    helper.controller = "ann";
    expect(fails(state, { type: "open", by: "ann", unit: "cy", poi: hoard.id })).toMatch(/your own hero/);
    const step = stepZone(state, { type: "open", by: "ann", unit: "ann", poi: hoard.id });
    if (!step.ok) throw new Error(step.error);
    expect(step.effects.map((e) => e.heroId).sort()).toEqual(["ann", "bo"]);
    for (const e of step.effects) expect(e).toEqual({ type: "grant", heroId: e.heroId, xp: CHEST_PAY.hoard.xp, resources: {} });
    // What is in it is one lot for the party, first come first served, taken from beside it: a piece of gear for
    // certain, and gold. Bo gets there first and has all of it; there is none left for Ann.
    let open = step.state;
    expect(fails(open, { type: "take", by: "ann", unit: "cy", spot: hoard.id })).toMatch(/your own hero/);
    expect(fails(open, { type: "take", by: "bo", unit: "bo", spot: hoard.id })).toMatch(/Go up to it/);
    unit(open, "bo").pos = beside[1];
    const took = stepZone(open, { type: "take", by: "bo", unit: "bo", spot: hoard.id });
    if (!took.ok) throw new Error(took.error);
    open = took.state;
    expect(took.effects.every((e) => e.heroId === "bo")).toBe(true);
    expect(took.effects.filter((e) => !!e.item)).toHaveLength(1);
    const gold = took.effects[0].gold!;
    expect(gold).toBeGreaterThanOrEqual(CHEST_PAY.hoard.gold[0]);
    expect(gold).toBeLessThanOrEqual(CHEST_PAY.hoard.gold[1]);
    expect(fails(open, { type: "take", by: "ann", unit: "ann", spot: hoard.id })).toMatch(/nothing left in it/);
    expect(open.loot!.find((s) => s.id === hoard.id)).toMatchObject({ shared: [], loot: {} });
  });

  it("costs an Action to open a chest in a fight", () => {
    let { state } = duel("dummy");
    state.map.pois.push({ id: "chest9", kind: "cache", pos: at(5, 7), hidden: false, cleared: false, usedBy: [], enemies: [], loot: "chest" });
    state = must(state, { type: "open", by: "ann", unit: "ann", poi: "chest9" });
    expect(state.encounter!.budgets.ann.ap).toBe(AP_TURN - ACTION_AP);
    state.encounter!.budgets.ann.ap = 1;
    state.map.pois.push({ id: "chest10", kind: "cache", pos: at(5, 6), hidden: false, cleared: false, usedBy: [], enemies: [], loot: "chest" });
    expect(fails(state, { type: "open", by: "ann", unit: "ann", poi: "chest10" })).toMatch(/takes 2 AP/);
  });
});

// ---------- crates ----------

describe("crates", () => {
  /** A crate standing on a hex, with this much left in it. */
  const crate = (state: ZoneState, id: string, pos: HexPos, hp = CRATE_HP) => {
    state.map.pois.push({ id, kind: "crate", pos, hidden: false, cleared: false, usedBy: [], enemies: [], hp, maxHp: CRATE_HP });
    return id;
  };
  const poi = (state: ZoneState, id: string) => state.map.pois.find((p) => p.id === id)!;
  const hits = (events: ZoneEvent[], id: string) => events.filter((e): e is Extract<ZoneEvent, { t: "crate_hit" }> => e.t === "crate_hit" && e.poi === id);
  /** A hero beside a crate, out of any fight. */
  function beside(classId = "qa_paladin", hp = CRATE_HP) {
    const state = board();
    hero(state, "ann", classId, at(5, 6));
    crate(state, "crate1", at(6, 6), hp);
    return state;
  }

  it("are stacked about a delve, and never shut off any of the floor, a chest or each other", () => {
    const delveOptions = zoneOptions({ biome: "caves", delve: true, party: 2, level: 3 });
    let total = 0;
    for (let seed = 0; seed < 16; seed++) {
      const where = `seed ${seed}`;
      const state = createZone("DLVE", `d${seed}`, delveOptions);
      const crates = state.map.pois.filter((p) => p.kind === "crate");
      const chests = state.map.pois.filter((p) => p.kind === "cache");
      total += crates.length;
      expect(crates.length, where).toBeGreaterThanOrEqual(DELVE_CRATES[0]);
      expect(new Set(crates.map((c) => c.id)).size, where).toBe(crates.length);
      /** The floor walkable from the mouth, round whatever stands on these hexes. A locked door can be opened, so it counts as a way through. */
      const walkable = (blocked: Set<string>) => {
        const seen = new Set([posKey(state.start)]);
        const queue = [state.start];
        for (let i = 0; i < queue.length; i++) {
          for (const n of hexNeighbors(queue[i], state.map.grid)) {
            const t = state.map.tiles.find((x) => x.q === n.q && x.r === n.r);
            if (!t || (solid(t) && t.biome !== "gate") || seen.has(posKey(n)) || blocked.has(posKey(n))) continue;
            seen.add(posKey(n));
            queue.push(n);
          }
        }
        return seen;
      };
      const crateKeys = new Set(crates.map((c) => posKey(c.pos)));
      const withChests = walkable(new Set(chests.map((c) => posKey(c.pos))));
      const withAll = walkable(new Set([...chests, ...crates].map((c) => posKey(c.pos))));
      for (const c of crates) {
        expect(c.hp, where).toBe(CRATE_HP);
        expect(state.map.tiles.find((t) => t.q === c.pos.q && t.r === c.pos.r)?.biome, where).toBe("cave");
        expect(state.units.some((u) => posKey(u.pos) === posKey(c.pos)), where).toBe(false);
        expect(hexDistance(c.pos, state.start), where).toBeGreaterThan(2);
        // Never right beside a chest, so it never stands where a chest is opened from.
        for (const chest of chests) expect(hexDistance(c.pos, chest.pos), where).toBeGreaterThan(1);
        // Every crate can be walked up to, to be broken.
        expect(hexNeighbors(c.pos, state.map.grid).some((n) => withAll.has(posKey(n))), where).toBe(true);
      }
      // Nothing the party could walk to before is cut off by them, and every chest can still be got beside.
      for (const key of withChests) if (!crateKeys.has(key)) expect(withAll.has(key), `${where} ${key}`).toBe(true);
      for (const chest of chests) expect(hexNeighbors(chest.pos, state.map.grid).some((n) => withAll.has(posKey(n))), where).toBe(true);
      // They are something to break, not something to open: the cave is cleared without them.
      expect(unopened(state), where).toBe(chests.length);
    }
    expect(total / 16).toBeGreaterThan(DELVE_CRATES[0]);
  });

  it("stand in the way like a chest: nobody walks, jumps or is shoved onto one, and the splinters can be walked over", () => {
    let state = beside();
    expect(zoneReach(state, unit(state, "ann"), 10).has(posKey(at(6, 6)))).toBe(false);
    expect(fails(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) })).toMatch(/cannot get there/);
    expect(fails(state, { type: "common", by: "ann", unit: "ann", what: "jump", at: at(6, 6) })).toMatch(/nowhere to land/);
    // Shoved back into one, an enemy goes down where it stands.
    const shoved = board();
    shoved.aiOff = true;
    hero(shoved, "ann", "qa_paladin", at(4, 6));
    const foe = enemy(shoved, "dummy", at(5, 6));
    crate(shoved, "crate1", at(6, 6));
    let pushed: ZoneState | null = null;
    for (let seed = 1; seed < 40 && !pushed; seed++) {
      const step = stepZone({ ...shoved, rng: seed }, { type: "common", by: "ann", unit: "ann", what: "shove", target: foe.id });
      if (step.ok && step.events.some((e) => e.t === "shoved")) pushed = step.state;
    }
    expect(pushed).not.toBeNull();
    expect(unit(pushed!, foe.id).pos).toEqual(at(5, 6));
    // Broken, it is only splinters.
    poi(state, "crate1").cleared = true;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(unit(state, "ann").pos).toEqual(at(6, 6));
  });

  it("always takes a hero's blow: no roll, no fight, no Focus spent, and the damage comes off", () => {
    const state = beside("qa_paladin", 60);
    const events: ZoneEvent[] = [];
    const next = must(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: "crate1", focus: true }, events);
    const [hit] = hits(events, "crate1");
    expect(hit).toMatchObject({ actor: "ann", what: "bash" });
    expect(hit.amount).toBeGreaterThan(0);
    expect(poi(next, "crate1").hp).toBe(60 - hit.amount);
    expect(events.some((e) => e.t === "roll")).toBe(false);
    expect(events).toContainEqual({ t: "used", id: "ann", what: "bash", name: ABILITIES.bash.name, target: "crate1", at: undefined });
    expect(next.encounter).toBeNull();
    expect(unit(next, "ann").focus).toBe(unit(state, "ann").focus);
  });

  it("breaks at 0 and pays whoever broke it: wood, maybe gold and a find, and no XP", () => {
    let state = beside("qa_paladin", 1);
    const step = stepZone(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: "crate1" });
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    expect(step.events).toContainEqual({ t: "crate_hit", poi: "crate1", actor: "ann", amount: 1, what: "bash" });
    expect(step.events).toContainEqual({ t: "crate_broken", poi: "crate1", id: "ann" });
    expect(poi(state, "crate1")).toMatchObject({ cleared: true, hp: 0 });
    expect(step.effects).toHaveLength(1);
    const grant = step.effects[0];
    expect(grant).toMatchObject({ type: "grant", heroId: "ann", xp: 0 });
    expect(grant.resources.wood).toBeGreaterThanOrEqual(CRATE_PAY.wood[0]);
    expect(grant.item).toBeUndefined();
    expect(step.events.some((e) => e.t === "spoils" && e.id === "ann" && e.xp === 0)).toBe(true);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: "crate1" })).toMatch(/broken already/);

    // Over many crates: always wood, often gold, now and then a potion or a torch, in the pack at once.
    const found = { gold: 0, potion: 0, torch: 0 };
    for (let seed = 1; seed <= 200; seed++) {
      const fresh = beside("qa_paladin", 1);
      fresh.rng = seed;
      const one = stepZone(fresh, { type: "use", by: "ann", unit: "ann", ability: "bash", target: "crate1" });
      if (!one.ok) throw new Error(one.error);
      const g = one.effects[0];
      const wood = g.resources.wood ?? 0;
      expect(wood).toBeGreaterThanOrEqual(CRATE_PAY.wood[0]);
      expect(wood).toBeLessThanOrEqual(CRATE_PAY.wood[1]);
      if (g.gold) {
        found.gold += 1;
        expect(g.gold).toBeGreaterThanOrEqual(CRATE_PAY.gold[0]);
        expect(g.gold).toBeLessThanOrEqual(CRATE_PAY.gold[1]);
      }
      if (g.items?.healing) found.potion += 1;
      if (g.items?.torch) found.torch += 1;
      expect(unit(one.state, "ann").items.healing ?? 0).toBe((unit(fresh, "ann").items.healing ?? 0) + (g.items?.healing ?? 0));
    }
    expect(found.gold).toBeGreaterThan(80);
    expect(found.potion).toBeGreaterThan(5);
    expect(found.potion).toBeLessThan(60);
    expect(found.torch).toBeGreaterThan(5);
  });

  it("needs a melee blow from beside it, and a shot or a spell from in range with a clear line", () => {
    const state = board(tileEdit(at(7, 6), { biome: "rock" }));
    hero(state, "ann", "qa_paladin", at(4, 6));
    const rogue = hero(state, "bo", "refactor_rogue", at(10, 6));
    crate(state, "crate1", at(6, 6));
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: "crate1" })).toMatch(/next to it/);
    expect(fails(state, { type: "use", by: "bo", unit: "bo", ability: "bow_shot", target: "crate1" })).toMatch(/no clear line/);
    rogue.pos = at(6, 9);
    const events: ZoneEvent[] = [];
    must(state, { type: "use", by: "bo", unit: "bo", ability: "bow_shot", target: "crate1" }, events);
    expect(hits(events, "crate1")).toHaveLength(1);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: "nothing" })).toMatch(/Pick an enemy/);
  });

  it("is caught by a sweep all round, a swing, a blast and a thrown bomb", () => {
    // A sweep with nothing but a crate beside you still swings.
    let state = beside("qa_paladin", 60);
    unit(state, "ann").abilities = ["stoke_the_fire", "cleave"];
    let events: ZoneEvent[] = [];
    must(state, { type: "use", by: "ann", unit: "ann", ability: "stoke_the_fire" }, events);
    expect(hits(events, "crate1")).toHaveLength(1);
    // So does a swing at it, but not one the other way.
    events = [];
    must(state, { type: "use", by: "ann", unit: "ann", ability: "cleave", at: at(6, 6) }, events);
    expect(hits(events, "crate1")).toHaveLength(1);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "cleave", at: at(4, 6) })).toMatch(/No enemy is in that swing/);
    poi(state, "crate1").pos = at(9, 9);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "stoke_the_fire" })).toMatch(/No enemy is next to you/);

    state = board();
    const mage = hero(state, "ann", "devops_mage", at(3, 6));
    mage.abilities = ["chorus"];
    crate(state, "crate1", at(6, 6), 60);
    crate(state, "crate2", at(7, 6), 60);
    crate(state, "crate3", at(9, 6), 60);
    events = [];
    must(state, { type: "use", by: "ann", unit: "ann", ability: "chorus", at: at(6, 6) }, events);
    expect(hits(events, "crate1")).toHaveLength(1);
    expect(hits(events, "crate2")).toHaveLength(1);
    expect(hits(events, "crate3")).toHaveLength(0);
    // The blast's one roll, all of it: a crate makes no save.
    expect(hits(events, "crate1")[0].amount).toBe(hits(events, "crate2")[0].amount);

    // Acid eats into it; a poison flask, which does no harm as it lands, leaves it be.
    unit(state, "ann").items.acid = 1;
    events = [];
    must(state, { type: "throw", by: "ann", unit: "ann", item: "acid", at: at(6, 6) }, events);
    expect(hits(events, "crate1").map((h) => h.what)).toEqual(["throw:acid"]);
    events = [];
    must(state, { type: "throw", by: "ann", unit: "ann", item: "poison", at: at(6, 6) }, events);
    expect(hits(events, "crate1")).toEqual([]);
  });

  it("burns in fire: as it takes hold, and again each round it lasts, in a fight or out of one", () => {
    // A fire bomb: the blast, then the flames under it.
    let state = board();
    hero(state, "ann", "devops_mage", at(3, 6));
    crate(state, "crate1", at(6, 6), 60);
    let events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(6, 6) }, events);
    expect(hits(events, "crate1").map((h) => h.what)).toEqual(["throw:fire", "fire"]);
    expect(hits(events, "crate1")[1].actor).toBe("ann");

    // In a fight it burns on at the turn of each round.
    let fight = duel("dummy").state;
    crate(fight, "crate9", at(6, 9), 60);
    fight = paint(fight, "fire", [at(6, 9)]);
    expect(poi(fight, "crate9").hp).toBeLessThan(60);
    const after = poi(fight, "crate9").hp!;
    events = [];
    fight = must(fight, { type: "end_turn", by: "ann", unit: "ann" }, events);
    expect(events.some((e) => e.t === "round")).toBe(true);
    expect(hits(events, "crate9")).toHaveLength(1);
    expect(poi(fight, "crate9").hp).toBe(after - hits(events, "crate9")[0].amount);

    // Out of a fight, each round of time that passes burns it again, and its breaker is whoever started the fire.
    state = must(state, { type: "time", now: 1_000_000 });
    const before = poi(state, "crate1").hp!;
    events = [];
    state = must(state, { type: "time", now: 1_000_000 + 2 * EXPLORE_ROUND_MS }, events);
    expect(hits(events, "crate1").map((h) => [h.what, h.actor])).toEqual([["fire", "ann"], ["fire", "ann"]]);
    expect(poi(state, "crate1").hp).toBe(before - hits(events, "crate1").reduce((n, h) => n + h.amount, 0));
  });

  it("pays the player whose stand-in broke it, and nobody for a fire no hero started", () => {
    const state = board();
    hero(state, "ann", "qa_paladin", at(2, 2));
    const helper = hero(state, "s1", "qa_paladin", at(5, 6));
    helper.controller = "ann";
    crate(state, "crate1", at(6, 6), 1);
    const step = stepZone(state, { type: "use", by: "ann", unit: "s1", ability: "bash", target: "crate1" });
    if (!step.ok) throw new Error(step.error);
    expect(step.events).toContainEqual({ t: "crate_broken", poi: "crate1", id: "s1" });
    expect(step.effects.map((e) => e.heroId)).toEqual(["ann"]);

    const burnt = board();
    hero(burnt, "ann", "qa_paladin", at(2, 2));
    crate(burnt, "crate1", at(6, 6), 1);
    const fire = stepZone(burnt, { type: "dev", by: "ann", dev: { op: "paint", kind: "fire", hexes: [at(6, 6)] } });
    if (!fire.ok) throw new Error(fire.error);
    expect(fire.events).toContainEqual({ t: "crate_broken", poi: "crate1", id: null });
    expect(fire.effects).toEqual([]);
  });

  it("is broken with a hero's own blow when simply clicked: by hand from beside it, else a shot or a spell that reaches", () => {
    const state = board();
    const ann = hero(state, "ann", "qa_paladin", at(5, 6));
    const bo = hero(state, "bo", "devops_mage", at(10, 6));
    crate(state, "crate1", at(6, 6));
    expect(crateBlow(state, ann, "crate1")).toBe("bash");
    expect(crateBlow(state, bo, "crate1")).toBe("shock");
    ann.pos = at(3, 6);
    expect(crateBlow(state, ann, "crate1")).toBeNull();
    // A blow that is not ready yet is passed over.
    bo.cooldowns.chain_lightning = 1;
    bo.abilities = ["chain_lightning", "shock"];
    expect(crateBlow(state, bo, "crate1")).toBe("shock");
  });

  it("can be struck, shot and bombed out of a fight: no fight starts, nothing is spent, and it pays at once", () => {
    // A band stands close by, not yet roused: only an attack that reaches one of them starts a fight.
    let state = board();
    hero(state, "ann", "qa_paladin", at(5, 6));
    hero(state, "bo", "refactor_rogue", at(4, 9));
    const mage = hero(state, "cy", "devops_mage", at(3, 3));
    mage.abilities = ["chorus"];
    mage.items = { ...mage.items, fire: 2 };
    const foe = enemy(state, "dummy", at(10, 6));
    crate(state, "crate1", at(6, 6), 1);
    crate(state, "crate2", at(6, 9), 1);
    crate(state, "crate3", at(7, 3), 60);
    crate(state, "crate4", at(9, 6), 60);
    const quiet = (s: ZoneState) => {
      expect(s.encounter).toBeNull();
      expect(s.groups.g1.alerted).toBe(false);
    };

    // A blow by hand: it breaks, and what was in it is paid there and then.
    let step = stepZone(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: "crate1" });
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    quiet(state);
    expect(step.events).toContainEqual({ t: "crate_broken", poi: "crate1", id: "ann" });
    expect(step.effects).toMatchObject([{ type: "grant", heroId: "ann", xp: 0 }]);
    expect(step.events.some((e) => e.t === "spoils" && e.id === "ann")).toBe(true);

    // A shot from across the chamber.
    step = stepZone(state, { type: "use", by: "bo", unit: "bo", ability: "bow_shot", target: "crate2" });
    if (!step.ok) throw new Error(step.error);
    state = step.state;
    quiet(state);
    expect(step.effects.map((e) => e.heroId)).toEqual(["bo"]);

    // A bomb thrown, and a blast with a wait on it used twice running: out of a fight neither Action nor wait counts.
    const events: ZoneEvent[] = [];
    state = must(state, { type: "throw", by: "cy", unit: "cy", item: "fire", at: at(7, 3) }, events);
    state = must(state, { type: "use", by: "cy", unit: "cy", ability: "chorus", at: at(7, 3) }, events);
    state = must(state, { type: "use", by: "cy", unit: "cy", ability: "chorus", at: at(7, 3) }, events);
    quiet(state);
    expect(hits(events, "crate3").map((h) => h.what)).toEqual(["throw:fire", "fire", "chorus", "chorus"]);
    expect(unit(state, "cy").cooldowns).toEqual({});

    // A blast that catches the band as well as a crate: that one starts a fight, with the band that was hit.
    const both: ZoneEvent[] = [];
    unit(state, "cy").pos = at(5, 4);
    state = must(state, { type: "use", by: "cy", unit: "cy", ability: "chorus", at: at(9, 6) }, both);
    expect(hits(both, "crate4")).toHaveLength(1);
    expect(state.groups.g1.alerted).toBe(true);
    expect(state.encounter?.order).toContain(foe.id);
    // The blast that started it goes into the fight waiting, as if cast on the Mage's first turn; their AP are not touched.
    expect(unit(state, "cy").cooldowns).toEqual({ chorus: TACTICS.chorus.cooldown });
    expect(state.encounter!.banked?.cy).toBeUndefined();
  });

  it("costs the Action in a fight", () => {
    let { state } = duel("dummy");
    crate(state, "crate1", at(5, 7), 60);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: "crate1" });
    expect(state.encounter!.budgets.ann.ap).toBe(AP_TURN - ACTION_AP);
    state.encounter!.budgets.ann.ap = 1;
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: "crate1" })).toMatch(/takes 2 AP/);
  });

  it("keeps a hero arriving off one", () => {
    let state = board();
    // Every hex round the start but one has a crate on it.
    const around = hexNeighbors(state.start, state.map.grid);
    around.slice(1).forEach((p, i) => crate(state, `crate${i + 1}`, p));
    crate(state, "crate0", state.start);
    state = must(state, { type: "join", hero: standInHero("qa_paladin", "ann", 1)! });
    expect(unit(state, "ann").pos).toEqual(around[0]);
  });
});

// ---------- a hero's sheet ----------

describe("a hero's sheet", () => {
  it("is read again when they come back in different gear, but not in the middle of a fight", () => {
    const changed = { ...standInHero("qa_paladin", "ann", 1)!, armor: 9 };
    let state = board();
    hero(state, "ann", "qa_paladin", at(5, 6));
    state = must(state, { type: "join", hero: changed });
    expect(unit(state, "ann").armor).toBe(9);

    const fight = duel().state;
    const before = unit(fight, "ann").armor;
    expect(unit(must(fight, { type: "join", hero: changed }), "ann").armor).toBe(before);
  });
});

// ---------- what a hero carries ----------

describe("what a hero carries", () => {
  it("is what their pack holds when they walk in, and the starting kit for one with no pack", () => {
    let state = board();
    state = must(state, { type: "join", hero: { ...standInHero("qa_paladin", "ann", 1)!, items: { healing: 5 } } });
    expect(unit(state, "ann").items).toEqual({ healing: 5 });
    state = must(state, { type: "join", hero: standInHero("devops_mage", "bo", 1)! });
    expect(unit(state, "bo").items).toEqual({ healing: 2, poison: 2, fire: 1, oil: 1, water: 1, torch: 2 });
  });

  it("follows the pack when the server says what it holds now, even in a fight", () => {
    const { state } = duel();
    const next = must(state, { type: "stock", unit: "ann", items: { healing: 1, fire: 0, nonsense: 4 } as never });
    expect(unit(next, "ann").items).toEqual({ healing: 1 });
    // And coming back mid-fight keeps the gear but takes the pack's count.
    const back = must(state, { type: "join", hero: { ...standInHero("qa_paladin", "ann", 1)!, armor: 9, items: { poison: 3 } } });
    expect(unit(back, "ann").items).toEqual({ poison: 3 });
    expect(unit(back, "ann").armor).toBe(unit(state, "ann").armor);
  });

  it("is topped up to the starting kit by the dev restock, and never cut down", () => {
    let state = board();
    const ann = hero(state, "ann", "qa_paladin", at(5, 6));
    ann.items = { healing: 7, poison: 0 };
    state = must(state, { type: "dev", by: "ann", dev: { op: "heal" } });
    expect(unit(state, "ann").items).toEqual({ healing: 7, poison: 2, fire: 1, oil: 1, water: 1, torch: 2 });
  });
});

// ---------- a troll ----------

describe("a troll", () => {
  it("grows back at the start of each of its turns, unless it is burning", () => {
    const { state, foe } = duel("troll");
    unit(state, foe).hp = 5;
    const events: ZoneEvent[] = [];
    const healed = must(state, { type: "end_turn", by: "ann", unit: "ann" }, events);
    expect(unit(healed, foe).hp).toBe(5 + ENEMIES.troll.regen!.amount);
    expect(events).toContainEqual({ t: "heal", actor: foe, target: foe, amount: ENEMIES.troll.regen!.amount, what: "Regenerate" });

    unit(state, foe).conditions.push({ kind: "burning", rounds: 3 });
    const lit = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    expect(unit(lit, foe).hp).toBeLessThan(5);
  });
});

describe("the Paladin's class abilities", () => {
  /**
   * A Paladin (ann) and two crewmates in a fight with a dummy: bo two hexes from ann, cy three. Ann's turn.
   * `spare` is another hex beside ann, left empty.
   */
  function party() {
    let state = board();
    state.aiOff = true;
    const annAt = at(5, 6);
    const dummyAt = at(6, 6);
    const [spare] = hexNeighbors(annAt, state.map.grid).filter((p) => !sameHexes(p, dummyAt));
    const ann = hero(state, "ann", "qa_paladin", annAt);
    ann.abilities = ["beacon_aura", "healing_aura", "branding_strike", "stoke_the_fire", "bolster", "show_the_way"];
    hero(state, "bo", "refactor_rogue", at(3, 6));
    hero(state, "cy", "devops_mage", at(2, 6));
    const dummy = enemy(state, "dummy", dummyAt);
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    // bo at the edge of an aura's reach, cy just past it.
    expect(hexDistance(unit(state, "ann").pos, unit(state, "bo").pos)).toBe(AURAS.range);
    expect(hexDistance(unit(state, "ann").pos, unit(state, "cy").pos)).toBe(AURAS.range + 1);
    expect(hexDistance(unit(state, "ann").pos, dummy.pos)).toBe(1);
    return { state, dummy: dummy.id, spare };
  }
  const sameHexes = (a: HexPos, b: HexPos) => a.q === b.q && a.r === b.r;
  const lasts = (state: ZoneState, kind: string) => unit(state, "ann").conditions.find((c) => c.kind === kind)?.rounds;

  it("are all in the Paladin's pool", () => {
    expect(poolFor("qa_paladin").map((e) => e.id)).toEqual(["beacon_aura", "healing_aura", "branding_strike", "stoke_the_fire", "bolster", "show_the_way"]);
  });

  it("Beacon Aura: a Bonus action that gives the Paladin and allies within 2 hexes +2 to hit, not anyone further off", () => {
    let { state, dummy } = party();
    const foe = () => unit(state, dummy);
    const before = (id: string, melee: boolean) => attackContext(state, unit(state, id), foe(), { melee });
    const was = { bo: before("bo", true), ann: before("ann", true), cy: before("cy", false), foe: attackContext(state, foe(), unit(state, "ann"), { melee: true }) };
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "beacon_aura" });
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    const bo = attackContext(state, unit(state, "bo"), foe(), { melee: true });
    expect(bo.mods).toBe(was.bo.mods + AURAS.beaconHit);
    expect(bo.adv).toBe(was.bo.adv);
    expect(bo.notes.join()).toMatch(/\+2 an ally's Beacon/);
    const ann = attackContext(state, unit(state, "ann"), foe(), { melee: true });
    expect(ann.mods).toBe(was.ann.mods + AURAS.beaconHit);
    expect(ann.adv).toBe(was.ann.adv);
    expect(ann.notes.join()).toMatch(/\+2 your Beacon/);
    // Too far off for it.
    expect(attackContext(state, unit(state, "cy"), foe(), { melee: false }).mods).toBe(was.cy.mods);
    // Enemies beside the Paladin get nothing from it.
    const theirs = attackContext(state, foe(), unit(state, "ann"), { melee: true });
    expect([theirs.mods, theirs.adv]).toEqual([was.foe.mods, was.foe.adv]);
  });

  it("Beacon Aura: lights the dark around the Paladin while it lasts, and lasts 4 of the Paladin's turns after this one", () => {
    let { state } = party();
    state.options = { ...state.options, biome: "caves" };
    // In a Diving Helm, so only the Beacon lights the dark.
    unit(state, "ann").outfit = IN_A_DIVING_HELM;
    const near = hexNeighbors(unit(state, "ann").pos, state.map.grid)[0];
    expect(litHexes(state)!.has(posKey(near))).toBe(false);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "beacon_aura" });
    expect(litHexes(state)!.has(posKey(near))).toBe(true);
    for (let turn = 1; turn <= 4; turn++) {
      state = nextTurn(state);
      expect(lasts(state, "beacon"), `turn ${turn}`).toBeGreaterThan(0);
    }
    state = endShared(state);
    expect(lasts(state, "beacon")).toBeUndefined();
    expect(litHexes(state)!.has(posKey(near))).toBe(false);
  });

  it("Healing Aura: heals the Paladin and allies within 2 hexes at the start of each of their next 4 turns", () => {
    let { state } = party();
    for (const id of ["ann", "bo", "cy"]) unit(state, id).hp = 1;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "healing_aura" });
    expect(state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - BONUS_AP);
    // Nothing on the turn it is put up.
    expect(unit(state, "ann").hp).toBe(1);
    const events: ZoneEvent[] = [];
    for (let turn = 0; turn < 6; turn++) state = nextTurn(state, events);
    const healed = (id: string) => events.filter((e) => e.t === "heal" && e.what === "healing_aura" && e.target === id);
    expect(healed("ann")).toHaveLength(4);
    expect(healed("bo")).toHaveLength(4);
    expect(healed("cy")).toHaveLength(0);
    for (const e of healed("ann")) if (e.t === "heal") expect(e.amount).toBeGreaterThanOrEqual(AURAS.heal.plus + 1);
    expect(unit(state, "cy").hp).toBe(1);
  });

  it("Healing Aura: does not get a fallen ally up", () => {
    let { state } = party();
    Object.assign(unit(state, "bo"), { hp: 0, down: true });
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "healing_aura" });
    state = nextTurn(state);
    expect(unit(state, "bo").down).toBe(true);
  });

  it("Branding Strike: an Action blow that sets what it hits Burning, and needs a rest after", () => {
    let hits = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let { state, dummy } = party();
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "branding_strike", target: dummy }, events);
      const hit = events.some((e) => e.t === "hit" && e.target === dummy);
      if (hit) hits++;
      expect(unit(state, dummy).conditions.some((c) => c.kind === "burning")).toBe(hit);
      expect(state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - ACTION_AP);
      expect(fails(nextTurn(state), { type: "use", by: "ann", unit: "ann", ability: "branding_strike", target: dummy })).toMatch(/not ready/);
    }
    expect(hits).toBeGreaterThan(0);
  });

  it("Branding Strike: hits harder than a Bash", () => {
    expect(ABILITIES.branding_strike.damage!).toBeGreaterThan(ABILITIES.bash.damage!);
  });

  it("Stoke the Fire: strikes every enemy beside the Paladin and sets the ones it hits Burning, and nothing further off", () => {
    let hits = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let { state, dummy, spare } = party();
      const second = enemy(state, "dummy", spare).id;
      const far = enemy(state, "dummy", at(8, 6)).id;
      expect(hexDistance(unit(state, "ann").pos, unit(state, second).pos)).toBe(1);
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "stoke_the_fire" }, events);
      for (const id of [dummy, second]) {
        const hit = events.some((e) => e.t === "hit" && e.target === id);
        if (hit) hits++;
        expect(unit(state, id).conditions.some((c) => c.kind === "burning"), `seed ${seed} ${id}`).toBe(hit);
      }
      expect(events.some((e) => (e.t === "roll" && e.roll.target === far) || (e.t === "hit" && e.target === far))).toBe(false);
      expect(unit(state, far).conditions).toEqual([]);
    }
    expect(hits).toBeGreaterThan(0);
  });

  const wardOf = (state: ZoneState, id: string) => unit(state, id).conditions.find((c) => c.kind === "bolstered")?.amount;

  it("Bolster: an Action that shields the Paladin and allies within 2 hexes, not anyone further off", () => {
    let { state } = party();
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bolster" }, events);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - ACTION_AP });
    const size = BOLSTER.shield + unit(state, "ann").level;
    // The event says how big the shield is, for the bars to show it as the fight is played out.
    expect(events.filter((e) => e.t === "condition" && e.kind === "bolstered").map((e) => e.t === "condition" && [e.target, e.amount])).toEqual([["ann", size], ["bo", size]]);
    expect(wardOf(state, "ann")).toBe(size);
    expect(wardOf(state, "bo")).toBe(size);
    expect(wardOf(state, "cy")).toBeUndefined();
    expect(fails(nextTurn(state), { type: "use", by: "ann", unit: "ann", ability: "bolster" })).toMatch(/not ready/);
  });

  it("Bolster: the shield takes a blow's damage before HP, and is gone once spent", () => {
    let { state } = party();
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bolster" });
    const events: ZoneEvent[] = [];
    const ctx: Ctx = { state: structuredClone(state), rng: makeRng(3), events, effects: [] };
    const bo = unit(ctx.state, "bo");
    const hp = bo.hp;
    const size = wardOf(ctx.state, "bo")!;
    expect(damage(ctx, bo, size - 3, { actor: null, what: "test" })).toBe(0);
    expect(bo.hp).toBe(hp);
    expect(wardOf(ctx.state, "bo")).toBe(3);
    expect(damage(ctx, bo, 5, { actor: null, what: "test" })).toBe(2);
    expect(bo.hp).toBe(hp - 2);
    expect(wardOf(ctx.state, "bo")).toBeUndefined();
    expect(events.filter((e) => e.t === "hit").map((e) => e.t === "hit" && [e.amount, e.blocked])).toEqual([[0, size - 3], [2, 3]]);
  });


  it("Bolster: wears off after 3 of the bearer's turns", () => {
    let { state } = party();
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bolster" });
    for (let turn = 1; turn <= BOLSTER.rounds; turn++) {
      state = nextTurn(state);
      expect(lasts(state, "bolstered"), `turn ${turn}`).toBeGreaterThan(0);
    }
    state = endShared(state);
    expect(lasts(state, "bolstered")).toBeUndefined();
  });

  it("Show the Way: lifts every harmful condition off an ally, and leaves the good ones", () => {
    let { state } = party();
    const bo = unit(state, "bo");
    bo.conditions = (["burning", "poisoned", "slowed", "exposed", "hasted"] as const).map((kind) => ({ kind, rounds: 3 }));
    const before = state.encounter!.budgets.ann.ap;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" });
    expect(unit(state, "bo").conditions.map((c) => c.kind)).toEqual(["hasted"]);
    expect(state.encounter!.budgets.ann.ap).toBe(before - BONUS_AP);
  });

  it("Show the Way: heals the ally a little, less than a Mend", () => {
    let { state } = party();
    unit(state, "bo").hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" }, events);
    expect(unit(state, "bo").hp).toBeGreaterThan(1);
    expect(events.some((e) => e.t === "heal" && e.target === "bo" && e.what === "show_the_way")).toBe(true);
    expect(ABILITIES.show_the_way.heal!).toBeLessThan(ABILITIES.mend.heal!);
  });

  it("Show the Way: clears the fire, poison, oil, ice and slime off the way you would walk, but not water, nor ground off it", () => {
    let { state } = party();
    const annPos = unit(state, "ann").pos;
    const boPos = unit(state, "bo").pos;
    // The straight way is barred (by what is left of a wall: nobody walks through it, anyone sees over it): the walk goes round.
    const between = at(4, 6);
    expect(hexDistance(annPos, between) + hexDistance(between, boPos)).toBe(hexDistance(annPos, boPos));
    // (A new array with a new tile in it: a state's tiles are shared from step to step, so one is never changed where it lies.)
    state.map.tiles = state.map.tiles.map((t) => (sameHexes(t, between) ? { ...t, prop: "wall_broken" } : t));
    const way = wayBetween(state, unit(state, "ann"), boPos);
    expect(way).toHaveLength(4);
    expect(way.some((p) => sameHexes(p, between))).toBe(false);
    expect(way[0]).toEqual(annPos);
    expect(way[3]).toEqual(boPos);
    const lay = (pos: HexPos, kind: SurfaceKind) => (state.surfaces[posKey(pos)] = { kind, rounds: 5, by: null });
    lay(way[0], "oil");
    lay(way[1], "fire");
    lay(way[2], "slime");
    lay(way[3], "ice");
    lay(between, "poison");
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" });
    for (const p of way) expect(state.surfaces[posKey(p)], posKey(p)).toBeUndefined();
    expect(state.surfaces[posKey(between)].kind).toBe("poison");
    // Water is no harm, and stays.
    ({ state } = party());
    lay(at(4, 6), "water");
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" });
    expect(state.surfaces[posKey(at(4, 6))].kind).toBe("water");
  });

  it("Show the Way: with no way on foot to the ally, clears the straight line instead", () => {
    let { state } = party();
    const annPos = unit(state, "ann").pos;
    const boPos = unit(state, "bo").pos;
    // Enemies all round bo (cy, who could be walked past, out of the way): there is no walking to them.
    unit(state, "cy").pos = at(1, 1);
    for (const p of hexNeighbors(boPos, state.map.grid)) if (!unitAt(state, p)) enemy(state, "dummy", p);
    const way = wayBetween(state, unit(state, "ann"), boPos);
    expect(way).toEqual([annPos, at(4, 6), boPos]);
    for (const p of way) state.surfaces[posKey(p)] = { kind: "fire", rounds: 5, by: null };
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "show_the_way", target: "bo" });
    for (const p of way) expect(state.surfaces[posKey(p)], posKey(p)).toBeUndefined();
  });

  it("Show the Way: takes the way over oil and slime, not round them", () => {
    const { state } = party();
    for (const p of [at(4, 6), ...hexNeighbors(at(4, 6), state.map.grid)]) state.surfaces[posKey(p)] = { kind: "slime", rounds: 5, by: null };
    expect(wayBetween(state, unit(state, "ann"), unit(state, "bo").pos)).toHaveLength(3);
  });
});

describe("the Mage's class abilities", () => {
  /**
   * A Mage (ann) and a crewmate (bo) two hexes off along the row, in a fight with a dummy far down it. Ann's turn.
   * Everyone stands on row 6, so hexes along it are in a straight line.
   */
  function party(abilities = ["soothing_rain", "chain_lightning", "roar_of_thunder", "trade_winds", "tidal_wave"]) {
    let state = board();
    state.aiOff = true;
    const ann = hero(state, "ann", "devops_mage", at(5, 6));
    ann.abilities = abilities;
    hero(state, "bo", "qa_paladin", at(3, 6));
    const dummy = enemy(state, "dummy", at(13, 6));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    return { state, dummy: dummy.id };
  }
  /** Put a dummy down somewhere, in the fight. */
  function addDummy(state: ZoneState, pos: HexPos): string {
    const e = enemy(state, "dummy", pos);
    state.encounter!.order.push(e.id);
    state.encounter!.init[e.id] = 0;
    return e.id;
  }
  const healsOf = (events: ZoneEvent[], id: string) => events.filter((e) => e.t === "heal" && e.what === "soothing_rain" && e.target === id).length;

  it("are all in the Mage's pool", () => {
    expect(poolFor("devops_mage").map((e) => e.id)).toEqual(["soothing_rain", "chain_lightning", "roar_of_thunder", "trade_winds", "tidal_wave"]);
  });

  it("Soothing Rain: a 3-hex cloud that lays water, and heals the caster's side under it as it comes, not the enemy", () => {
    let { state } = party();
    const foe = addDummy(state, at(3, 7));
    for (const id of ["ann", "bo", foe]) unit(state, id).hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "soothing_rain", at: at(3, 6) }, events);
    const area = abilityArea(state, unit(state, "ann"), "soothing_rain", at(3, 6));
    expect(area).toHaveLength(3);
    for (const p of area) for (const q of area) expect(hexDistance(p, q)).toBeLessThanOrEqual(1);
    for (const p of area) expect(state.surfaces[posKey(p)]?.kind).toBe("water");
    expect(state.weather).toHaveLength(1);
    expect(healsOf(events, "bo")).toBe(1);
    expect(healsOf(events, "ann")).toBe(0);
    expect(healsOf(events, foe)).toBe(0);
    expect(state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - ACTION_AP);
  });

  it("Soothing Rain: heals as a turn starts in it, and once a turn for walking in, however often", () => {
    let { state } = party();
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "soothing_rain", at: at(3, 6) });
    const area = state.weather![0].hexes;
    const out = at(3, 4);
    expect(area.some((p) => hexDistance(p, out) === 0)).toBe(false);
    unit(state, "bo").hp = 1;
    // Ann walks in and out and in again on her turn: one heal.
    unit(state, "ann").hp = 1;
    const walked: ZoneEvent[] = [];
    const inside = area.find((p) => !state.units.some((u) => u.pos.q === p.q && u.pos.r === p.r))!;
    state.encounter!.budgets.ann.move = 99;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: inside }, walked);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) }, walked);
    state = must(state, { type: "move", by: "ann", unit: "ann", to: inside }, walked);
    expect(healsOf(walked, "ann")).toBe(1);
    // On the next turn, bo (still standing in it) is healed as it starts.
    const turn: ZoneEvent[] = [];
    state = nextTurn(state, turn);
    expect(healsOf(turn, "bo")).toBe(1);
  });

  it("Soothing Rain: puts its water back at the start of every turn, and clears after 3 rounds", () => {
    let { state } = party();
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "soothing_rain", at: at(3, 6) });
    const area = state.weather![0].hexes;
    for (const p of area) delete state.surfaces[posKey(p)];
    state = nextTurn(state);
    for (const p of area) expect(state.surfaces[posKey(p)]?.kind).toBe("water");
    for (let round = 1; round <= 3; round++) {
      expect(state.weather, `round ${round}`).toHaveLength(1);
      state = nextTurn(state);
    }
    expect(state.weather).toHaveLength(0);
  });

  it("Chain Lightning: leaps to the nearest enemy within 2 hexes it has not struck, on and on, each struck once", () => {
    for (let seed = 1; seed <= 6; seed++) {
      let { state, dummy } = party();
      state.rng = seed;
      const chain = [at(7, 6), at(9, 6), at(10, 6), at(8, 7)].map((p) => addDummy(state, p));
      // 3 hexes from the nearest of the chain: never reached. (The first dummy is further still.)
      const apart = addDummy(state, at(13, 8));
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "chain_lightning", target: chain[0] }, events);
      const struck = events.filter((e) => e.t === "roll" && e.roll.kind === "attack").map((e) => e.t === "roll" && e.roll.target);
      expect(new Set(struck).size).toBe(struck.length);
      expect(new Set(struck)).toEqual(new Set(chain));
      expect(struck).not.toContain(apart);
      expect(struck).not.toContain(dummy);
    }
  });

  it("Roar of Thunder: never misses, always throws the enemy a hex back, and Stuns it unless it saves", () => {
    const outcomes = new Set<boolean>();
    for (let seed = 1; seed <= 12; seed++) {
      let { state } = party();
      state.rng = seed;
      const foe = addDummy(state, at(7, 6));
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "roar_of_thunder", target: foe }, events);
      expect(events.some((e) => e.t === "roll" && e.roll.kind === "attack")).toBe(false);
      const save = events.find((e) => e.t === "roll" && e.roll.kind === "save");
      expect(save?.t === "roll" && save.roll.label).toBe("Resist Roar of Thunder");
      const saved = save?.t === "roll" && save.roll.ok;
      outcomes.add(!!saved);
      expect(has(state, foe, "stunned")).toBe(!saved);
      expect(unit(state, foe).pos).toEqual(at(8, 6));
      expect(fails(nextTurn(state), { type: "use", by: "ann", unit: "ann", ability: "roar_of_thunder", target: foe })).toMatch(/not ready/);
      expect(tacticOf("roar_of_thunder").cooldown).toBe(2);
    }
    // Over the seeds, the Stun is sometimes shaken off and sometimes not.
    expect(outcomes).toEqual(new Set([true, false]));
  });

  it("Trade Winds: 19 hexes that Haste the caster's side and Slow the enemy in them", () => {
    let { state } = party();
    const foe = addDummy(state, at(4, 6));
    const outside = addDummy(state, at(9, 6));
    // Two hexes round (2, 6): Bo at 1 and the dummy at 2 are in it; Ann, at 3, is not.
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "trade_winds", at: at(2, 6) });
    expect(state.weather![0].hexes).toHaveLength(19);
    expect(has(state, "bo", "hasted")).toBe(true);
    expect(has(state, foe, "slowed")).toBe(true);
    expect(has(state, outside, "slowed")).toBe(false);
    expect(has(state, "ann", "hasted")).toBe(false);
  });

  it("Trade Winds: a turn started in them goes twice as far, or half, and walking in on your turn counts too", () => {
    let { state } = party();
    const before = state.encounter!.budgets.bo.move;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "trade_winds", at: at(3, 6) });
    // Bo shares ann's turn: Hasted now, the move doubles at once.
    expect(state.encounter!.budgets.bo.move).toBe(before * 2);
    state = nextTurn(state);
    expect(has(state, "bo", "hasted")).toBe(true);
    // Ann walks into the winds on her turn.
    state.encounter!.budgets.ann.move = 3;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(4, 6) });
    expect(has(state, "ann", "hasted")).toBe(true);
  });

  it("Tidal Wave: strikes only enemies in the line, and sweeps those that fail to brace to the far end", () => {
    let swept = 0;
    for (let seed = 1; seed <= 10; seed++) {
      let { state } = party();
      state.rng = seed;
      const near = addDummy(state, at(6, 6));
      const far = addDummy(state, at(8, 6));
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "tidal_wave", at: at(6, 6) }, events);
      const saved = (id: string) => events.some((e) => e.t === "roll" && e.roll.kind === "save" && e.roll.id === id && e.roll.ok);
      // The line runs from at(6,6) to at(10,6). The far one goes first, to the end; the near one after it, past whoever
      // stood their ground (nobody bars the way), to the end as well: there is room for two on the last hex.
      expect(unit(state, far).pos).toEqual(saved(far) ? at(8, 6) : at(10, 6));
      expect(unit(state, near).pos).toEqual(saved(near) ? at(6, 6) : at(10, 6));
      swept += [near, far].filter((id) => !saved(id)).length;
      expect(events.some((e) => e.t === "hit" && e.target === "bo")).toBe(false);
      // The line is left under water, and whoever is on it soaked.
      for (let col = 6; col <= 10; col++) expect(state.surfaces[posKey(at(col, 6))]?.kind, `col ${col}`).toBe("water");
      for (const id of [near, far]) expect(unit(state, id).conditions.some((c) => c.kind === "wet")).toBe(true);
    }
    expect(swept).toBeGreaterThan(0);
  });
});

describe("the Rogue's class abilities", () => {
  const ALL = ["smugglers_route", "sneak", "pickpocket", "tactical_retreat", "contraband"];
  /**
   * A Rogue (ann) with a crewmate (bo) beside her and another (cy) further off, in a fight with a dummy far down
   * row 6. Ann's turn. `edit` changes the board first.
   */
  function party(edit?: (tile: Tile) => void) {
    let state = board(edit);
    state.aiOff = true;
    const ann = hero(state, "ann", "refactor_rogue", at(5, 6));
    ann.abilities = [...ann.abilities, ...ALL];
    hero(state, "bo", "qa_paladin", at(4, 6));
    hero(state, "cy", "devops_mage", at(2, 8));
    const dummy = enemy(state, "dummy", at(13, 6));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    return { state, dummy: dummy.id };
  }
  function addFoe(state: ZoneState, pos: HexPos, kind = "dummy"): string {
    const e = enemy(state, kind, pos);
    state.encounter!.order.push(e.id);
    state.encounter!.init[e.id] = 0;
    return e.id;
  }
  const step = (state: ZoneState, action: ZoneAction) => {
    const s = stepZone(state, action);
    if (!s.ok) throw new Error(s.error);
    return s;
  };
  const rock = (...hexes: HexPos[]) => (t: Tile) => { if (hexes.some((p) => p.q === t.q && p.r === t.r)) t.biome = "rock"; };

  it("are all in the Rogue's pool", () => {
    expect(poolFor("refactor_rogue").map((e) => e.id)).toEqual(ALL);
  });

  it("Smuggler's Route: a Bonus action to a hex up to 3 off, through a wall, spending no movement", () => {
    let { state } = party(rock(at(6, 5), at(6, 6), at(6, 7)));
    const move = state.encounter!.budgets.ann.move;
    const events: ZoneEvent[] = [];
    state = must(state, use("smugglers_route", { at: at(8, 6) }), events);
    expect(unit(state, "ann").pos).toEqual(at(8, 6));
    expect(events.some((e) => e.t === "blinked" && e.id === "ann")).toBe(true);
    expect(state.encounter!.budgets.ann).toMatchObject({ move, ap: AP_TURN - BONUS_AP });
    expect(unit(state, "ann").cooldowns.smugglers_route).toBe(4);
    // Bo stayed: nobody was picked to come along.
    expect(unit(state, "bo").pos).toEqual(at(4, 6));
  });

  it("Smuggler's Route: not further than 3, nor onto rock or a hex with no room left on it", () => {
    let { state } = party(rock(at(7, 6)));
    expect(fails(state, use("smugglers_route", { at: at(9, 6) }))).toMatch(/Too far/);
    expect(fails(state, use("smugglers_route", { at: at(7, 6) }))).toMatch(/nowhere to stand/);
    // Two stand on Bo's hex: it is full.
    unit(state, "cy").pos = at(4, 6);
    expect(fails(state, use("smugglers_route", { at: at(4, 6) }))).toMatch(/nowhere to stand/);
    // With only Bo on it, there is room beside them.
    unit(state, "cy").pos = at(2, 8);
    state = must(state, use("smugglers_route", { at: at(4, 6) }));
    expect(unit(state, "ann").pos).toEqual(at(4, 6));
    expect(unit(state, "bo").pos).toEqual(at(4, 6));
  });

  it("Smuggler's Route: an ally beside you comes too, to the same side of where you land, or the nearest open hex", () => {
    let { state } = party();
    state = must(state, use("smugglers_route", { target: "bo", at: at(8, 6) }));
    expect(unit(state, "ann").pos).toEqual(at(8, 6));
    expect(unit(state, "bo").pos).toEqual(at(7, 6));
    // A friend on that side does not take it: there is room for Bo on their hex.
    let shared = party().state;
    unit(shared, "cy").pos = at(7, 6);
    shared = must(shared, use("smugglers_route", { target: "bo", at: at(8, 6) }));
    expect(unit(shared, "bo").pos).toEqual(at(7, 6));
    // An enemy there does, one being enough: Bo arrives on the nearest open hex beside where Ann lands.
    let again = party().state;
    const held = addFoe(again, at(7, 6));
    again = must(again, use("smugglers_route", { target: "bo", at: at(8, 6) }));
    expect(hexDistance(unit(again, "bo").pos, at(8, 6))).toBe(1);
    expect(hexDistance(unit(again, "bo").pos, at(7, 6))).toBe(1);
    expect(unit(again, held).pos).toEqual(at(7, 6));
    // And Ann herself cannot land on a hex an enemy holds.
    expect(fails(again, use("smugglers_route", { at: at(7, 6) }))).toMatch(/nowhere to stand/);
  });

  it("Smuggler's Route: the ally has to be beside you, and there has to be room for them", () => {
    const { state } = party();
    expect(fails(state, use("smugglers_route", { target: "cy", at: at(8, 6) }))).toMatch(/beside you/);
    const boxed = party(rock(...hexNeighbors(at(8, 6), GRID))).state;
    expect(fails(boxed, use("smugglers_route", { target: "bo", at: at(8, 6) }))).toMatch(/no room/);
    // Alone, the same hex is fine.
    expect(unit(must(boxed, use("smugglers_route", { at: at(8, 6) })), "ann").pos).toEqual(at(8, 6));
  });

  it("Smuggler's Route: leaving an enemy's side draws no blow", () => {
    let { state } = party();
    addFoe(state, at(6, 6), "bandit");
    const events: ZoneEvent[] = [];
    state = must(state, use("smugglers_route", { at: at(5, 9) }), events);
    expect(events.some((e) => e.t === "reaction")).toBe(false);
  });

  it("Sneak: you and every ally beside you go Unseen for 3 turns; one further off does not", () => {
    let { state } = party();
    state = must(state, use("sneak"));
    expect(has(state, "ann", "invisible")).toBe(true);
    expect(has(state, "bo", "invisible")).toBe(true);
    expect(has(state, "cy", "invisible")).toBe(false);
    expect(state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - ACTION_AP);
    // Through the 3 turns after the one it is used on (and every enemy turn between), and no further.
    for (let turn = 1; turn <= 4; turn++) {
      expect(has(state, "ann", "invisible"), `turn ${turn}`).toBe(true);
      state = nextTurn(state);
    }
    expect(has(state, "ann", "invisible")).toBe(false);
  });

  it("Sneak: an enemy will not attack the Unseen, nor strike at them as they walk off", () => {
    let { state } = party();
    const bandit = addFoe(state, at(6, 6), "bandit");
    state = must(state, use("sneak"));
    state.encounter!.budgets.ann.move = 20;
    const walked: ZoneEvent[] = [];
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(7, 4) }, walked);
    expect(walked.some((e) => e.t === "reaction")).toBe(false);
    // The bandit's turn: it has only cy to go for.
    state.aiOff = false;
    const turn: ZoneEvent[] = [];
    state = nextTurn(state, turn);
    const aimedAt = turn.filter((e) => e.t === "used" && e.id === bandit).map((e) => e.t === "used" && e.target);
    expect(aimedAt).not.toContain("ann");
    expect(aimedAt).not.toContain("bo");
  });

  it("Sneak: using an ability gives you away, with advantage on its roll to hit", () => {
    let { state, dummy } = party();
    state = must(state, use("sneak"));
    state = nextTurn(state);
    unit(state, dummy).pos = at(6, 6);
    const events: ZoneEvent[] = [];
    state = must(state, use("stab", { target: dummy }), events);
    const roll = events.find((e) => e.t === "roll" && e.roll.kind === "attack");
    expect(roll?.t === "roll" && roll.roll.adv).toBe(1);
    expect(has(state, "ann", "invisible")).toBe(false);
    expect(events.some((e) => e.t === "seen" && e.id === "ann")).toBe(true);
    // Bo, who did nothing, is still Unseen.
    expect(has(state, "bo", "invisible")).toBe(true);
  });

  it("Sneak: nobody out of a fight notices the Unseen walking by", () => {
    let state = board();
    const ann = hero(state, "ann", "refactor_rogue", at(2, 6));
    ann.conditions.push({ kind: "invisible", rounds: 3 });
    enemy(state, "bandit", at(8, 6));
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(6, 6) });
    expect(state.encounter).toBeNull();
  });

  it("Pickpocket: a Bonus action blow that, landing, pays gold equal to your level, once an enemy", () => {
    // A light cut: plain 1d6, its dice set outright rather than worked out from its damage.
    expect(abilityDiceFor(ABILITIES.pickpocket)).toEqual({ n: 1, d: 6, plus: 0 });
    let paid = 0;
    let missed = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let { state, dummy } = party();
      state.rng = seed;
      unit(state, "ann").level = 3;
      unit(state, dummy).pos = at(6, 6);
      const first = step(state, use("pickpocket", { target: dummy }));
      expect(first.state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
      const hit = first.events.some((e) => e.t === "hit" && e.target === dummy);
      const gold = first.effects.filter((e) => e.type === "grant").map((e) => e.gold);
      expect(gold).toEqual(hit ? [3] : []);
      if (!hit) {
        missed += 1;
        continue;
      }
      paid += 1;
      expect(unit(first.state, dummy).picked).toBe(true);
      // Its pockets are empty now: the next one, even landing, pays nothing.
      state = first.state;
      state.encounter!.budgets.ann.ap = AP_MAX;
      delete unit(state, "ann").cooldowns.pickpocket;
      expect(step(state, use("pickpocket", { target: dummy })).effects).toEqual([]);
    }
    expect(paid).toBeGreaterThan(0);
    expect(missed).toBeGreaterThan(0);
  });

  it("Pickpocket: Unseen, it is no blow, just the gold, and you stay Unseen", () => {
    let { state, dummy } = party();
    state = must(state, use("sneak"));
    state = nextTurn(state);
    unit(state, dummy).pos = at(6, 6);
    const hp = unit(state, dummy).hp;
    const s = step(state, use("pickpocket", { target: dummy }));
    expect(s.events.some((e) => e.t === "roll")).toBe(false);
    expect(unit(s.state, dummy).hp).toBe(hp);
    expect(s.effects).toEqual([{ type: "grant", heroId: "ann", xp: 0, resources: {}, gold: 1 }]);
    expect(has(s.state, "ann", "invisible")).toBe(true);
  });

  it("Tactical Retreat: a heavy blow, then away to a hex up to 4 off if one is picked, hit or miss", () => {
    for (let seed = 1; seed <= 4; seed++) {
      let { state, dummy } = party(rock(at(6, 5), at(5, 5)));
      state.rng = seed;
      unit(state, dummy).pos = at(6, 6);
      const events: ZoneEvent[] = [];
      state = must(state, use("tactical_retreat", { target: dummy, at: at(5, 3) }), events);
      expect(events.filter((e) => e.t === "roll" && e.roll.kind === "attack")).toHaveLength(1);
      expect(unit(state, "ann").pos).toEqual(at(5, 3));
      expect(state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - ACTION_AP);
    }
    // No hex picked: the blow alone.
    let { state, dummy } = party();
    unit(state, dummy).pos = at(6, 6);
    state = must(state, use("tactical_retreat", { target: dummy }));
    expect(unit(state, "ann").pos).toEqual(at(5, 6));
    // A hex further off than that is refused.
    const far = party();
    unit(far.state, far.dummy).pos = at(6, 6);
    expect(fails(far.state, use("tactical_retreat", { target: far.dummy, at: at(10, 6) }))).toBe("Too far.");
  });

  it("Tactical Retreat: hits harder than a Stab", () => {
    expect(ABILITIES.tactical_retreat.damage!).toBeGreaterThan(ABILITIES.stab.damage!);
  });

  it("Contraband: you and an ally each get a fire bomb, thrown before any of your own, gone after 3 turns", () => {
    let { state } = party();
    unit(state, "ann").items.fire = 0;
    state = must(state, use("contraband", { target: "bo" }));
    expect(state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - BONUS_AP);
    expect(has(state, "ann", "contraband")).toBe(true);
    expect(has(state, "bo", "contraband")).toBe(true);
    // Ann has none of her own, and can throw one all the same.
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) });
    expect(has(state, "ann", "contraband")).toBe(false);
    expect(unit(state, "ann").items.fire ?? 0).toBe(0);
    // Bo's own bomb is still in his pack after throwing the smuggled one.
    state = must(state, { type: "throw", by: "bo", unit: "bo", item: "fire", at: at(10, 7) });
    expect(unit(state, "bo").items.fire).toBe(1);
    expect(has(state, "bo", "contraband")).toBe(false);
    // Not thrown, it is gone after the 3 turns that follow.
    let later = party().state;
    later = must(later, use("contraband", { target: "ann" }));
    for (let turn = 1; turn <= 3; turn++) later = nextTurn(later);
    expect(has(later, "ann", "contraband")).toBe(true);
    later = nextTurn(later);
    expect(has(later, "ann", "contraband")).toBe(false);
  });

  it("Contraband: used on yourself, both bombs are yours", () => {
    let { state } = party();
    unit(state, "ann").items.fire = 0;
    state = must(state, use("contraband"));
    expect(has(state, "bo", "contraband")).toBe(false);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) });
    expect(has(state, "ann", "contraband")).toBe(true);
    state = nextTurn(state);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) });
    expect(has(state, "ann", "contraband")).toBe(false);
    state.encounter!.budgets.ann.ap = AP_MAX;
    expect(fails(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) })).toMatch(/no fire bomb/i);
  });

  it("throwing gives the Unseen away too", () => {
    let { state } = party();
    state = must(state, use("sneak"));
    state = nextTurn(state);
    state = must(state, { type: "throw", by: "ann", unit: "ann", item: "fire", at: at(10, 6) });
    expect(has(state, "ann", "invisible")).toBe(false);
  });
});

describe("the Druid's class abilities", () => {
  const ALL = ["coral_field", "aqueous_regeneration", "coral_armor", "revitalizing_splash", "summon_sea_turtle"];
  /** A Druid (ann) with a crewmate (bo) beside her and another (cy) further off, in a fight with a dummy far down row 6. Ann's turn. */
  function party() {
    let state = board();
    state.aiOff = true;
    const ann = hero(state, "ann", "backend_druid", at(5, 6));
    ann.abilities = [...ALL];
    hero(state, "bo", "qa_paladin", at(4, 6));
    hero(state, "cy", "devops_mage", at(2, 8));
    const dummy = enemy(state, "dummy", at(13, 6));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    return { state, dummy: dummy.id };
  }
  function addFoe(state: ZoneState, pos: HexPos, kind = "dummy"): string {
    const e = enemy(state, kind, pos);
    state.encounter!.order.push(e.id);
    state.encounter!.init[e.id] = -5;
    return e.id;
  }
  const cuts = (events: ZoneEvent[], id: string) => events.filter((e) => e.t === "hit" && e.what === "coral_field" && e.target === id).length;
  const turtleOf = (state: ZoneState) => state.units.filter((u) => u.summon?.by === "ann");

  it("are all in the Druid's pool", () => {
    expect(poolFor("backend_druid").map((e) => e.id)).toEqual(ALL);
  });

  it("Coral Field: 7 hexes for 4 rounds that cut and Slow the enemy under them, and leave your side alone", () => {
    let { state } = party();
    const foe = addFoe(state, at(8, 7));
    unit(state, "bo").pos = at(7, 5);
    const events: ZoneEvent[] = [];
    state = must(state, use("coral_field", { at: at(8, 6) }), events);
    expect(state.weather).toHaveLength(1);
    expect(state.weather![0]).toMatchObject({ kind: "coral", rounds: 4, side: "hero" });
    expect(state.weather![0].hexes).toHaveLength(7);
    expect(cuts(events, foe)).toBe(1);
    expect(has(state, foe, "slowed")).toBe(true);
    expect(cuts(events, "bo")).toBe(0);
    expect(has(state, "bo", "slowed")).toBe(false);
    expect(state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - ACTION_AP);
    expect(unit(state, "ann").cooldowns.coral_field).toBe(4);
  });

  it("Coral Field: cuts an enemy again as its turn starts in it, once a turn; your side walks through untouched; gone after 4 rounds", () => {
    let { state } = party();
    const foe = addFoe(state, at(8, 7));
    state = must(state, use("coral_field", { at: at(8, 6) }));
    const walked: ZoneEvent[] = [];
    state.encounter!.budgets.ann.move = 99;
    state = must(state, { type: "move", by: "ann", unit: "ann", to: at(9, 6) }, walked);
    expect(cuts(walked, "ann")).toBe(0);
    expect(has(state, "ann", "slowed")).toBe(false);
    const turn: ZoneEvent[] = [];
    state = nextTurn(state, turn);
    expect(cuts(turn, foe)).toBe(1);
    // Made part-way through a round, it lasts 4 whole rounds after it.
    for (let round = 2; round <= 5; round++) {
      expect(state.weather, `round ${round}`).toHaveLength(1);
      state = nextTurn(state);
    }
    expect(state.weather).toHaveLength(0);
  });

  it("Coral Field: the enemy steers round it if it can", () => {
    let state = board();
    hero(state, "ann", "backend_druid", at(5, 6)).abilities = [...ALL];
    const bandit = enemy(state, "bandit", at(10, 6));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann")) state = must(state, { type: "timeout" });
    // Coral on the straight way between them; open ground either side.
    state = must(state, use("coral_field", { at: at(8, 6) }));
    const events: ZoneEvent[] = [];
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" }, events);
    expect(cuts(events, bandit.id)).toBe(0);
  });

  it("Aqueous Regeneration: a Bonus action that heals now and at the start of each of the ally's next 3 turns, then stops", () => {
    let { state } = party();
    unit(state, "bo").hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, use("aqueous_regeneration", { target: "bo" }), events);
    expect(events.filter((e) => e.t === "heal" && e.target === "bo")).toHaveLength(1);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    const ticks = (evs: ZoneEvent[]) => evs.filter((e) => e.t === "heal" && e.target === "bo" && e.what === "aqueous_regeneration" && e.actor === null).length;
    for (let turn = 1; turn <= 3; turn++) {
      unit(state, "bo").hp = 1;
      const seen: ZoneEvent[] = [];
      state = nextTurn(state, seen);
      expect(ticks(seen), `turn ${turn}`).toBe(1);
    }
    unit(state, "bo").hp = 1;
    const after: ZoneEvent[] = [];
    state = nextTurn(state, after);
    expect(ticks(after)).toBe(0);
    expect(has(state, "bo", "regenerating")).toBe(false);
  });

  it("Rejuvenate: heals now, and the same again at the start of the ally's next turn, then stops", () => {
    let { state } = party();
    unit(state, "ann").abilities = [...unit(state, "ann").abilities, "rejuvenate"];
    unit(state, "bo").hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, use("rejuvenate", { target: "bo" }), events);
    const first = events.find((e) => e.t === "heal" && e.target === "bo" && e.what === "rejuvenate");
    if (first?.t !== "heal" || !first.dice) throw new Error("no heal");
    // 1d8+2, and the Druid's heal bonus on top.
    expect([first.dice.faces.length, first.dice.d]).toEqual([1, 8]);
    expect(first.dice.plus).toBeGreaterThanOrEqual(2);
    expect(has(state, "bo", "rejuvenating")).toBe(true);
    const again = (evs: ZoneEvent[]) => evs.filter((e) => e.t === "heal" && e.target === "bo" && e.what === "rejuvenate" && e.actor === null);
    unit(state, "bo").hp = 1;
    const seen: ZoneEvent[] = [];
    state = nextTurn(state, seen);
    const second = again(seen);
    expect(second).toHaveLength(1);
    // The same heal: the same dice, and the same bonus on top.
    expect(second[0].t === "heal" && second[0].dice).toMatchObject({ d: 8, plus: first.dice.plus });
    unit(state, "bo").hp = 1;
    const after: ZoneEvent[] = [];
    state = nextTurn(state, after);
    expect(again(after)).toHaveLength(0);
    expect(has(state, "bo", "rejuvenating")).toBe(false);
  });

  it("Aqueous Regeneration: heals 2 more, now and each turn, for one standing in water", () => {
    const amounts = (wet: boolean) => {
      let { state } = party();
      if (wet) state = paint(state, "water", [at(4, 6)]);
      unit(state, "bo").hp = 1;
      const events: ZoneEvent[] = [];
      state = must(state, use("aqueous_regeneration", { target: "bo" }), events);
      unit(state, "bo").hp = 1;
      state = nextTurn(state, events);
      return events.filter((e) => e.t === "heal" && e.target === "bo").map((e) => (e.t === "heal" ? e.amount : 0));
    };
    const dry = amounts(false);
    const wet = amounts(true);
    expect(dry).toHaveLength(2);
    expect(wet).toEqual(dry.map((n) => n + AQUEOUS.water));
    expect(AQUEOUS.water).toBe(2);
  });

  it("Coral Armor: +2 Defence on the ally for 3 of their turns, in reach 3", () => {
    let { state } = party();
    const before = defenceOf(unit(state, "bo"));
    state = must(state, use("coral_armor", { target: "bo" }));
    expect(defenceOf(unit(state, "bo"))).toBe(before + 2);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    // Put on during bo's own (shared) turn: that turn does not count against it.
    for (let turn = 1; turn <= 3; turn++) state = nextTurn(state);
    expect(has(state, "bo", "coral_armor")).toBe(true);
    state = nextTurn(state);
    expect(has(state, "bo", "coral_armor")).toBe(false);
    expect(fails(party().state, use("coral_armor", { target: "cy" }))).toMatch(/Out of range/);
  });

  it("Coral Armor: an enemy that lands a blow up close is cut; one that shoots, or misses, is not", () => {
    let cut = 0;
    for (let seed = 1; seed <= 12; seed++) {
      let { state } = party();
      state = must(state, use("coral_armor", { target: "bo" }));
      const bandit = enemy(state, "bandit", at(4, 5));
      const archer = enemy(state, "archer", at(4, 9));
      const ctx: Ctx = { state, rng: makeRng(seed), events: [], effects: [] };
      enemyAct(ctx, bandit, enemyStrikes("bandit", 1)[0], unit(state, "bo"));
      enemyAct(ctx, archer, enemyStrikes("archer", 1).find((s) => s.range > 1)!, unit(state, "bo"));
      const landed = (id: string) => ctx.events.some((e) => e.t === "hit" && e.actor === id && e.target === "bo");
      const thorns = (id: string) => ctx.events.some((e) => e.t === "hit" && e.what === "coral_armor" && e.target === id);
      expect(thorns(bandit.id)).toBe(landed(bandit.id));
      expect(thorns(archer.id)).toBe(false);
      if (landed(bandit.id)) cut++;
    }
    expect(cut).toBeGreaterThan(0);
  });

  it("Revitalizing Splash: a heal over 4 hexes for your side, the fallen got up, enemies passed over, and water left", () => {
    let { state } = party();
    const foe = addFoe(state, at(7, 6));
    unit(state, "bo").pos = at(7, 5);
    Object.assign(unit(state, "bo"), { hp: 0, down: true });
    unit(state, foe).hp = 1;
    unit(state, "ann").hp = 1;
    const events: ZoneEvent[] = [];
    state = must(state, use("revitalizing_splash", { at: at(7, 5) }), events);
    const area = abilityArea(state, unit(state, "ann"), "revitalizing_splash", at(7, 5));
    expect(area).toHaveLength(4);
    for (const p of area) expect(state.surfaces[posKey(p)]?.kind).toBe("water");
    expect(unit(state, "bo").down).toBe(false);
    // Got up from 0 with the heal: 1d8+2 at the least, and the Druid's bonus on top.
    expect(unit(state, "bo").hp).toBeGreaterThanOrEqual(3);
    expect(events.some((e) => e.t === "heal" && e.target === foe)).toBe(false);
    expect(events.some((e) => e.t === "heal" && e.target === "ann")).toBe(false);
    expect(state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - ACTION_AP);
    expect(unit(state, "ann").cooldowns.revitalizing_splash).toBe(3);
  });

  it("Summon Sea Turtle: called to a hex in reach, it takes its turn with you, played by you, and bites", () => {
    let { state } = party();
    const foe = addFoe(state, at(8, 6));
    state = must(state, use("summon_sea_turtle", { at: at(7, 6) }));
    const [turtle] = turtleOf(state);
    expect(turtle).toMatchObject({ side: "hero", kind: "sea_turtle", controller: "ann", pos: at(7, 6) });
    // Hard to hurt for its armor, not its HP: early on it has less to get through than the Druid who called it.
    expect(turtle.maxHp).toBeLessThan(unit(state, "ann").maxHp);
    expect(defenceOf(turtle)).toBeGreaterThanOrEqual(16);
    const enc = state.encounter!;
    expect(enc.order[enc.order.indexOf("ann") + 1]).toBe(turtle.id);
    expect(enc.acting).toContain(turtle.id);
    expect(enc.budgets[turtle.id]).toMatchObject({ ap: SUMMON_AP_TURN, move: 0, stride: 1 });
    // Ann's player plays it; nobody else does.
    expect(fails(state, { type: "use", by: "bo", unit: turtle.id, ability: "turtle_bite", target: foe })).toMatch(/not yours/);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: turtle.id, ability: "turtle_bite", target: foe }, events);
    expect(events.some((e) => e.t === "roll" && e.roll.id === turtle.id)).toBe(true);
    // Next round it is in the shared turn again.
    state = nextTurn(state);
    expect(state.encounter!.acting).toContain(turtle.id);
    expect(fails(state, { type: "common", by: "ann", unit: turtle.id, what: "flee" })).toMatch(/stays/);
  });

  it("Summon Sea Turtle: its Bite does 4 more while it stands in water", () => {
    const bites = (wet: boolean, seed: number) => {
      let { state } = party();
      const foe = addFoe(state, at(8, 6));
      if (wet) state = paint(state, "water", [at(7, 6)]);
      state = must(state, use("summon_sea_turtle", { at: at(7, 6) }));
      const turtle = turtleOf(state)[0];
      state.rng = seed;
      unit(state, foe).hp = 999;
      const events: ZoneEvent[] = [];
      must(state, { type: "use", by: "ann", unit: turtle.id, ability: "turtle_bite", target: foe }, events);
      return events.filter((e) => e.t === "hit" && e.actor === turtle.id).map((e) => (e.t === "hit" ? e.amount : 0));
    };
    // The same dice either way: a seed whose bite lands.
    const seed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10].find((n) => bites(false, n).length === 1)!;
    const dry = bites(false, seed);
    expect(bites(true, seed)).toEqual([dry[0] + 4]);
  });

  it("Summon Sea Turtle: only in a fight, in reach, on open ground; a second sends the first away", () => {
    let { state } = party();
    expect(fails(state, use("summon_sea_turtle", { at: at(9, 6) }))).toMatch(/Out of range/);
    expect(fails(state, use("summon_sea_turtle", { at: at(4, 6) }))).toMatch(/nowhere/);
    state = must(state, use("summon_sea_turtle", { at: at(7, 6) }));
    const first = turtleOf(state)[0].id;
    for (let i = 0; i < 5; i++) state = nextTurn(state);
    const events: ZoneEvent[] = [];
    state = must(state, use("summon_sea_turtle", { at: at(6, 7) }), events);
    expect(turtleOf(state)).toHaveLength(1);
    expect(turtleOf(state)[0].id).not.toBe(first);
    expect(state.encounter!.order).not.toContain(first);
    expect(events.some((e) => e.t === "dismissed" && e.id === first)).toBe(true);
    // Out of a fight there is nothing to call it to.
    let calm = board();
    hero(calm, "ann", "backend_druid", at(5, 6)).abilities = [...ALL];
    expect(fails(calm, use("summon_sea_turtle", { at: at(6, 6) }))).toMatch(/for a fight/);
  });

  it("Summon Sea Turtle: gone when it falls, and when the fight is over; it holds no lost fight off", () => {
    let { state } = party();
    state = must(state, use("summon_sea_turtle", { at: at(7, 6) }));
    let turtle = turtleOf(state)[0];
    // Falls.
    let fell = structuredClone(state);
    const ctx: Ctx = { state: fell, rng: makeRng(1), events: [], effects: [] };
    damage(ctx, turtleOf(fell)[0], 999, { actor: null, what: "test" });
    fell = must(fell, { type: "end_turn", by: "ann", unit: "ann" });
    expect(turtleOf(fell)).toHaveLength(0);
    expect(fell.encounter!.order).not.toContain(turtle.id);
    // The fight ends.
    const won = must(state, { type: "dev", by: "ann", dev: { op: "end_fight" } });
    expect(won.encounter).toBeNull();
    expect(turtleOf(won)).toHaveLength(0);
    // Every hero down, the turtle still standing: the fight is lost.
    turtle = turtleOf(state)[0];
    for (const id of ["ann", "bo", "cy"]) Object.assign(unit(state, id), { hp: 0, down: true });
    const lost: ZoneEvent[] = [];
    state = must(state, { type: "end_turn", by: "ann", unit: turtle.id }, lost);
    expect(lost.some((e) => e.t === "fight_end" && e.outcome === "defeat")).toBe(true);
    expect(turtleOf(state)).toHaveLength(0);
  });
});

describe("the Bard's shanties", () => {
  const ALL = ["lively_shanty", "dour_shanty", "windgod_shanty", "chorus", "lead_by_example"];
  /**
   * A Bard (ann) with a crewmate beside her (bo) and another 4 hexes off (cy), in a fight with a dummy far down row 6.
   * The three heroes share one turn, and it is theirs.
   */
  function party() {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "frontend_bard", at(5, 6)).abilities = [...ALL];
    hero(state, "bo", "qa_paladin", at(4, 6));
    hero(state, "cy", "devops_mage", at(2, 8));
    const dummy = enemy(state, "dummy", at(13, 6));
    state = provoke(state);
    const enc = state.encounter!;
    enc.order = ["ann", "bo", "cy", dummy.id];
    Object.assign(enc.init, { ann: 20, bo: 19, cy: 18, [dummy.id]: 1 });
    while (!["ann", "bo", "cy"].every((id) => state.encounter!.acting.includes(id))) state = must(state, { type: "timeout" });
    return { state, dummy: dummy.id };
  }
  const sing = (kind: string): ZoneAction => ({ type: "use", by: "ann", unit: "ann", ability: kind });
  const join = (who: string, bard = "ann"): ZoneAction => ({ type: "common", by: who, unit: who, what: "join", target: bard });
  const song = (state: ZoneState) => shantyOf(unit(state, "ann"))!;
  const hitMods = (state: ZoneState, id: string, dummy: string) => attackContext(state, unit(state, id), unit(state, dummy), { melee: false }).mods;

  it("are all in the Bard's pool", () => {
    expect(poolFor("frontend_bard").map((e) => e.id)).toEqual(ALL);
  });

  it("a shanty is a Bonus action, sung for 4 turns, 4 to wait; one at a time, the new one replacing the old", () => {
    let { state } = party();
    state = must(state, sing("lively_shanty"));
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    expect(song(state)).toMatchObject({ kind: "lively_shanty", rounds: 4, joined: [] });
    expect(unit(state, "ann").cooldowns.lively_shanty).toBe(5);
    state = nextTurn(state);
    state = must(state, sing("dour_shanty"));
    expect(has(state, "ann", "lively_shanty")).toBe(false);
    expect(song(state).kind).toBe("dour_shanty");
    // Sung through 4 more of the Bard's turns (the one it was struck up in does not count), then gone.
    for (let turn = 1; turn <= 4; turn++) state = nextTurn(state);
    expect(has(state, "ann", "dour_shanty")).toBe(true);
    state = nextTurn(state);
    expect(has(state, "ann", "dour_shanty")).toBe(false);
  });

  it("Lively Shanty: +2 to hit and more damage for the Bard and allies within 2, not one further off", () => {
    let { state, dummy } = party();
    const before = { ann: hitMods(state, "ann", dummy), bo: hitMods(state, "bo", dummy), cy: hitMods(state, "cy", dummy) };
    state = must(state, sing("lively_shanty"));
    expect(hitMods(state, "ann", dummy)).toBe(before.ann + 2);
    expect(hitMods(state, "bo", dummy)).toBe(before.bo + 2);
    expect(hitMods(state, "cy", dummy)).toBe(before.cy);
    expect(songsOn(state, unit(state, "bo"))).toHaveLength(1);
  });

  it("a creature called into the fight can join a shanty, once, for its own lift alone: no wider, and no more for anyone else", () => {
    let { state, dummy } = party();
    state = must(state, sing("lively_shanty"));
    // A sea turtle of Bo's, beside the Bard, taking its turn with Bo's.
    const turtle: Unit = { ...structuredClone(unit(state, "bo")), id: "s9", kind: "sea_turtle", pos: at(5, 7), summon: { by: "bo" }, controller: "bo", abilities: ["turtle_bite"], conditions: [] };
    state.units.push(turtle);
    const enc = state.encounter!;
    enc.order.splice(enc.order.indexOf("bo") + 1, 0, turtle.id);
    enc.init[turtle.id] = enc.init.bo;
    enc.acting.push(turtle.id);
    enc.budgets[turtle.id] = { ap: AP_TURN, move: 0, stride: 1, disengaged: false };
    const before = { radius: shantyRadius(song(state)), bo: hitMods(state, "bo", dummy) };
    const joinTurtle: ZoneAction = { type: "common", by: "bo", unit: turtle.id, what: "join", target: "ann" };
    state = must(state, joinTurtle);
    expect(has(state, turtle.id, "inspired")).toBe(true);
    expect(song(state)).toMatchObject({ joined: [], joinedOwn: [turtle.id], surge: 0 });
    expect(shantyRadius(song(state))).toBe(before.radius);
    expect(hitMods(state, "bo", dummy)).toBe(before.bo);
    expect(fails(state, joinTurtle)).toMatch(/no shanty here you have not joined/);
    // An ally joining still widens it and lifts everyone.
    state = must(state, join("bo"));
    expect(shantyRadius(song(state))).toBe(before.radius + 1);
  });

  it("Lively Shanty: joining is a Bonus action, once: a hex wider, advantage on your next attack, and +1 more to hit for all until the Bard's next turn", () => {
    let { state, dummy } = party();
    state = must(state, sing("lively_shanty"));
    state = must(state, join("bo"));
    expect(state.encounter!.budgets.bo.ap).toBeLessThanOrEqual(AP_TURN - BONUS_AP);
    expect(song(state).joined).toEqual(["bo"]);
    expect(shantyRadius(song(state))).toBe(3);
    expect(has(state, "bo", "inspired")).toBe(true);
    expect(attackContext(state, unit(state, "bo"), unit(state, dummy), { melee: false }).adv).toBe(1);
    const mods = hitMods(state, "ann", dummy);
    // Never twice, and never your own.
    expect(fails(nextTurn(state), join("bo"))).toMatch(/not joined/);
    expect(fails(state, join("ann"))).toMatch(/not joined|own/);
    // The extra +1 is gone once the Bard's turn comes round.
    state = nextTurn(state);
    expect(hitMods(state, "ann", dummy)).toBe(mods - 1);
  });

  it("Lively Shanty: the advantage from joining is spent on the next roll to hit", () => {
    let { state, dummy } = party();
    state = must(state, sing("lively_shanty"));
    state = must(state, join("bo"));
    unit(state, "bo").pos = at(12, 6);
    state = must(state, { type: "use", by: "bo", unit: "bo", ability: "bash", target: dummy });
    expect(has(state, "bo", "inspired")).toBe(false);
  });

  it("Dour Shanty: +2 Defence within reach; joining Guards you and adds +1 for everyone in it until the Bard's next turn", () => {
    let { state } = party();
    const before = { ann: defenceOf(unit(state, "ann"), state), bo: defenceOf(unit(state, "bo"), state), cy: defenceOf(unit(state, "cy"), state) };
    state = must(state, sing("dour_shanty"));
    expect(defenceOf(unit(state, "bo"), state)).toBe(before.bo + 2);
    expect(defenceOf(unit(state, "cy"), state)).toBe(before.cy);
    state = must(state, join("bo"));
    expect(has(state, "bo", "guarded")).toBe(true);
    expect(defenceOf(unit(state, "ann"), state)).toBe(before.ann + 3);
    expect(defenceOf(unit(state, "bo"), state)).toBe(before.bo + 3);
    state = nextTurn(state);
    expect(defenceOf(unit(state, "bo"), state)).toBe(before.bo + 2);
    // The hex it widened by stays.
    expect(shantyRadius(song(state))).toBe(3);
  });

  it("a shanty widens a hex for each who joins, reaching those it did not", () => {
    let { state } = party();
    state = must(state, sing("dour_shanty"));
    // cy is 4 off: out of reach, and so cannot join yet.
    expect(fails(state, join("cy"))).toMatch(/no shanty/);
    hero(state, "di", "qa_paladin", at(6, 6));
    state.encounter!.order.splice(3, 0, "di");
    state.encounter!.acting.push("di");
    state.encounter!.budgets.di = { ...state.encounter!.budgets.bo };
    state = must(state, join("bo"));
    expect(songsOn(state, unit(state, "cy"))).toHaveLength(0);
    state = must(state, join("di"));
    expect(songsOn(state, unit(state, "cy"))).toHaveLength(1);
    state = must(state, join("cy"));
    expect(song(state).joined).toEqual(["bo", "di", "cy"]);
  });

  it("Wind-god's Shanty: 1 more movement for each AP at once and every turn after, and no Slowing", () => {
    let { state } = party();
    unit(state, "bo").conditions.push({ kind: "slowed", rounds: 3 });
    const stride = state.encounter!.budgets.bo.stride;
    const base = heroMove(unit(state, "bo").stats!);
    state = must(state, sing("windgod_shanty"));
    expect(state.encounter!.budgets.bo.stride).toBe(stride + 1);
    expect(has(state, "bo", "slowed")).toBe(false);
    // Struck up again on a later turn, nothing more is owed for the turn the movement was already given in.
    state = nextTurn(state);
    expect(state.encounter!.budgets.bo.stride).toBe(base + 1);
    const ctx: Ctx = { state, rng: makeRng(1), events: [], effects: [] };
    addCondition(ctx, unit(state, "bo"), "slowed", 2);
    expect(has(state, "bo", "slowed")).toBe(false);
    // Out of its reach, Slowing takes as ever.
    addCondition(ctx, unit(state, "cy"), "slowed", 2);
    expect(has(state, "cy", "slowed")).toBe(true);
  });

  it("Wind-god's Shanty: joining Disengages you, and gives 1 more movement for each AP to everyone in it, that turn only", () => {
    let { state } = party();
    state = must(state, sing("windgod_shanty"));
    const { ann, bo } = state.encounter!.budgets;
    const [annStride, boStride] = [ann.stride, bo.stride];
    state = must(state, join("bo"));
    expect(state.encounter!.budgets.bo.disengaged).toBe(true);
    expect(state.encounter!.budgets.ann.disengaged).toBe(false);
    expect(state.encounter!.budgets.bo.stride).toBe(boStride + 1);
    expect(state.encounter!.budgets.ann.stride).toBe(annStride + 1);
    state = nextTurn(state);
    expect(state.encounter!.budgets.bo.stride).toBe(heroMove(unit(state, "bo").stats!) + 1);
  });

  function addFoe(state: ZoneState, pos: HexPos): string {
    const e = enemy(state, "dummy", pos);
    e.hp = e.maxHp = 999;
    state.encounter!.order.push(e.id);
    state.encounter!.init[e.id] = 0;
    return e.id;
  }

  it("Chorus: 7 hexes that strike and Slow only the enemy, 3 harder for each ally in it", () => {
    const strike = (allyIn: boolean, seed: number) => {
      let { state } = party();
      const foe = addFoe(state, at(8, 6));
      addFoe(state, at(9, 6));
      if (allyIn) unit(state, "bo").pos = at(7, 6);
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "chorus", at: at(8, 6) }, events);
      const saved = events.some((e) => e.t === "roll" && e.roll.kind === "save" && e.roll.id === foe && e.roll.ok);
      const amount = events.filter((e) => e.t === "hit" && e.target === foe).map((e) => (e.t === "hit" ? e.amount : 0))[0];
      return { state, events, saved, amount, foe };
    };
    const seed = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12].find((n) => !strike(false, n).saved)!;
    const alone = strike(false, seed);
    const sung = strike(true, seed);
    expect(sung.amount).toBe(alone.amount + 3);
    expect(sung.events.some((e) => e.t === "hit" && e.target === "bo")).toBe(false);
    expect(sung.state.units.find((u) => u.id === sung.foe)!.conditions.some((c) => c.kind === "slowed")).toBe(true);
    expect(sung.state.encounter!.budgets.ann.ap).toBeLessThanOrEqual(AP_TURN - ACTION_AP);
    expect(unit(sung.state, "ann").cooldowns.chorus).toBe(4);
  });

  it("Lead by Example: landed, it Inspires the ally nearest the target; missed, nobody", () => {
    let landedOnce = false;
    for (let seed = 1; seed <= 12; seed++) {
      let { state } = party();
      const foe = addFoe(state, at(8, 6));
      unit(state, "cy").pos = at(9, 7);
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, { type: "use", by: "ann", unit: "ann", ability: "lead_by_example", target: foe }, events);
      const landed = events.some((e) => e.t === "hit" && e.target === foe);
      landedOnce ||= landed;
      expect(has(state, "cy", "inspired")).toBe(landed);
      expect(has(state, "bo", "inspired")).toBe(false);
      expect(has(state, "ann", "inspired")).toBe(false);
      expect(unit(state, "ann").cooldowns.lead_by_example).toBe(3);
    }
    expect(landedOnce).toBe(true);
  });

  it("Join the Song is for a fight", () => {
    const state = board();
    hero(state, "ann", "frontend_bard", at(5, 6)).conditions.push({ kind: "lively_shanty", rounds: 4, joined: [] });
    hero(state, "bo", "qa_paladin", at(4, 6));
    expect(fails(state, join("bo"))).toMatch(/for a fight/);
  });
});

describe("a dev kit", () => {
  function onMap() {
    const state = board();
    hero(state, "ann", "qa_paladin", at(5, 6));
    hero(state, "bo", "devops_mage", at(3, 6));
    return state;
  }
  const kit = (unit: string, over: Partial<{ classId: string; weapon: string; level: number; abilities: string[] }> = {}): ZoneAction => ({
    type: "dev", by: "ann", dev: { op: "kit", unit, classId: "devops_mage", weapon: "tome", level: 7, abilities: ["chain_lightning", "tidal_wave", "soothing_rain", "trade_winds"], ...over },
  });

  it("makes your hero any class, level and weapon, with as many of the class's abilities as you like", () => {
    const state = must(onMap(), kit("ann"));
    const ann = unit(state, "ann");
    expect(ann).toMatchObject({ kind: "devops_mage", level: 7, devKit: true });
    expect(ann.abilities).toEqual([...WEAPONS.tome.abilities, "chain_lightning", "tidal_wave", "soothing_rain", "trade_winds"]);
    expect(ann.outfit?.main_hand?.ref).toBe("tome");
    expect(ann.hp).toBe(ann.maxHp);
  });

  it("drops abilities that are not the class's, and refuses a weapon of another class or a hero not yours", () => {
    expect(unit(must(onMap(), kit("ann", { abilities: ["bolster", "tidal_wave"] })), "ann").abilities).not.toContain("bolster");
    expect(fails(onMap(), kit("ann", { weapon: "mace" }))).toMatch(/weapon/);
    expect(fails(onMap(), kit("bo"))).toMatch(/not one of your heroes/);
  });

  it("holds through coming back to the map", () => {
    let state = must(onMap(), kit("ann"));
    state = must(state, { type: "join", hero: { ...standInHero("qa_paladin", "ann", 1)!, name: "ann" } });
    expect(unit(state, "ann")).toMatchObject({ kind: "devops_mage", level: 7 });
  });
});

describe("the Sage's stars", () => {
  const ALL = ["falling_star", "constellation", "new_moon", "chart_a_course", "north_star"];
  /**
   * A Sage (ann) with a crewmate 3 hexes along row 6 (bo) and another 3 past him (cy), in a fight with `foes` (dummies,
   * with HP to spare). The three heroes share one turn, and it is theirs.
   */
  function party(foes: HexPos[] = [at(14, 10)]) {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "staff_sage", at(5, 6)).abilities = [...ALL];
    hero(state, "bo", "qa_paladin", at(8, 6));
    hero(state, "cy", "devops_mage", at(11, 6));
    const ids = foes.map((pos) => {
      const e = enemy(state, "dummy", pos);
      e.hp = e.maxHp = 500;
      return e.id;
    });
    state = provoke(state);
    const enc = state.encounter!;
    enc.order = ["ann", "bo", "cy", ...ids];
    Object.assign(enc.init, { ann: 20, bo: 19, cy: 18 }, Object.fromEntries(ids.map((id) => [id, 1])));
    while (!["ann", "bo", "cy"].every((id) => state.encounter!.acting.includes(id))) state = must(state, { type: "timeout" });
    return { state, foes: ids };
  }
  const cast = (ability: string, aim: { target?: string; at?: HexPos } = {}): ZoneAction => ({ type: "use", by: "ann", unit: "ann", ability, ...aim });
  const hurt = (state: ZoneState, id: string) => unit(state, id).maxHp - unit(state, id).hp;

  it("are all in the Sage's pool", () => {
    expect(poolFor("staff_sage").map((e) => e.id)).toEqual(ALL);
  });

  it("Guiding Light: anyone attacking a lit enemy has advantage", () => {
    const { state, foes } = party();
    const ctx = () => attackContext(state, unit(state, "bo"), unit(state, foes[0]), { melee: false });
    expect(ctx().adv).toBe(0);
    unit(state, foes[0]).conditions.push({ kind: "guiding_light", rounds: 3 });
    expect(ctx().adv).toBe(1);
    expect(ctx().notes.join(" ")).toMatch(/Guiding Light/);
  });

  it("Falling Star: an Action, 7 hexes, 3 turns to wait; landed, the target burns and is lit for 3 of its turns", () => {
    let landed: ZoneState | null = null;
    for (let seed = 1; seed < 40 && !landed; seed++) {
      let { state, foes } = party([at(12, 6)]);
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, cast("falling_star", { target: foes[0] }), events);
      expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - ACTION_AP });
      expect(unit(state, "ann").cooldowns.falling_star).toBe(4);
      if (events.some((e) => e.t === "hit" && e.what === "falling_star")) landed = state;
      else expect(has(state, foes[0], "guiding_light")).toBe(false);
    }
    expect(landed).not.toBeNull();
    const target = landed!.units.find((u) => u.side === "enemy")!;
    expect(target.conditions.find((c) => c.kind === "guiding_light")?.rounds).toBe(3);
    expect(target.conditions.some((c) => c.kind === "burning")).toBe(true);
    // 7 hexes, and no further.
    const { state, foes } = party([at(13, 6)]);
    expect(fails(state, cast("falling_star", { target: foes[0] }))).toMatch(/range/);
  });

  it("Constellation: a Bonus action linking the Sage to ally after ally within 4; enemies on the links are struck and lit, the Sage's side untouched", () => {
    // Two foes on the line from ann to bo, one between bo and cy, one off the links altogether.
    let { state, foes } = party([at(6, 6), at(7, 6), at(10, 6), at(6, 9)]);
    expect(constellationLinks(state, unit(state, "ann")).map((l) => [l.from.id, l.to.id])).toEqual([["ann", "bo"], ["bo", "cy"]]);
    const ap = state.encounter!.budgets.ann.ap;
    state = must(state, cast("constellation"));
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: ap - BONUS_AP });
    expect(unit(state, "ann").cooldowns.constellation).toBe(3);
    for (const id of foes.slice(0, 3)) {
      expect(hurt(state, id)).toBeGreaterThan(0);
      expect(has(state, id, "guiding_light")).toBe(true);
    }
    expect(hurt(state, foes[3])).toBe(0);
    expect(has(state, foes[3], "guiding_light")).toBe(false);
    for (const id of ["ann", "bo", "cy"]) expect(hurt(state, id)).toBe(0);
  });

  it("Constellation: an ally more than 4 from the last one linked is left out, and with nobody to link it cannot be used", () => {
    let { state } = party();
    unit(state, "cy").pos = at(13, 6);
    expect(constellationLinks(state, unit(state, "ann")).map((l) => l.to.id)).toEqual(["bo"]);
    unit(state, "bo").pos = at(10, 6);
    expect(fails(state, cast("constellation"))).toMatch(/No ally/);
  });

  it("New Moon: puts out every Guiding Light, striking each lit enemy hard; the unlit are untouched", () => {
    let { state, foes } = party([at(12, 6), at(14, 9), at(2, 10)]);
    expect(fails(state, cast("new_moon"))).toMatch(/No enemy is lit/);
    for (const id of foes.slice(0, 2)) unit(state, id).conditions.push({ kind: "guiding_light", rounds: 3 });
    const ap = state.encounter!.budgets.ann.ap;
    state = must(state, cast("new_moon"));
    expect(state.encounter!.budgets.ann.ap).toBe(ap - ACTION_AP);
    expect(unit(state, "ann").cooldowns.new_moon).toBe(5);
    for (const id of foes.slice(0, 2)) {
      expect(has(state, id, "guiding_light")).toBe(false);
      expect(hurt(state, id)).toBeGreaterThanOrEqual(10);
    }
    expect(hurt(state, foes[2])).toBe(0);
  });

  it("Chart a Course: 1 AP marking a hex; the Sage's side moves 1 further for each AP, but only on steps toward it", () => {
    let { state } = party();
    const { ap, stride } = state.encounter!.budgets.bo;
    expect(fails(state, cast("chart_a_course", { at: at(14, 6) }))).toMatch(/range/);
    const annAp = state.encounter!.budgets.ann.ap;
    state = must(state, cast("chart_a_course", { at: at(13, 6) }));
    expect(state.encounter!.budgets.ann.ap).toBe(annAp - BONUS_AP);
    expect(chartOf(unit(state, "ann"))).toEqual(at(13, 6));
    expect(state.encounter!.budgets.bo.course).toBe(0);
    // Away from the mark, no further than ever.
    expect(fails(state, { type: "move", by: "bo", unit: "bo", to: at(8 - ap * stride - 1, 6) })).toMatch(/AP you have left/);
    // Toward it, CHART.speed further for each AP, the course's movement spent first. (Up row 6 from bo: cy is passed, the mark is past the end.)
    unit(state, "cy").pos = at(11, 2);
    unit(state, "ann").pos = at(5, 2);
    unit(state, "bo").pos = at(2, 6);
    const far = ap * (stride + CHART.speed);
    expect(fails(state, { type: "move", by: "bo", unit: "bo", to: at(2 + far + 1, 6) })).toMatch(/AP you have left/);
    // One AP's worth: a stride and the course's share of it.
    state = must(state, { type: "move", by: "bo", unit: "bo", to: at(2 + stride + CHART.speed, 6) });
    expect(state.encounter!.budgets.bo).toMatchObject({ ap: ap - 1, course: 0, move: 0 });
    state = must(state, { type: "move", by: "bo", unit: "bo", to: at(2 + far, 6) });
    expect(state.encounter!.budgets.bo).toMatchObject({ ap: 0, move: 0 });
  });

  it("Chart a Course: a way that wanders off and back still gets the course's movement for its steps toward the mark", () => {
    let { state } = party();
    state = must(state, cast("chart_a_course", { at: at(13, 6) }));
    const move = 5;
    // Rock in the way along row 6 a hex past bo: the walk has to go round it, a step off the row and back.
    // (A new array with a new tile in it: a state's tiles are shared from step to step, so one is never changed where it lies.)
    state.map.tiles = state.map.tiles.map((t) => (t.q === at(9, 6).q && t.r === 6 ? { ...t, biome: "rock" } : t));
    unit(state, "cy").pos = at(11, 2);
    const reach = zoneReach(state, unit(state, "bo"), move, undefined, { marks: [at(13, 6)], left: 3 });
    expect(reach.get(posKey(at(10, 6)))?.cost).toBeLessThan(3);
  });

  it("Chart a Course: the mark lasts 4 of the Sage's turns, gives each turn's movement anew, and a new mark replaces it", () => {
    let { state } = party();
    state = must(state, cast("chart_a_course", { at: at(13, 6) }));
    state = nextTurn(state);
    expect(state.encounter!.budgets.bo.course).toBe(0);
    expect(courseFor(state, unit(state, "bo"), state.encounter!.budgets.bo)?.left).toBe(state.encounter!.budgets.bo.ap * CHART.speed);
    // Ready again once 2 more of the Sage's turns have gone by.
    state = nextTurn(state);
    expect(fails(state, cast("chart_a_course", { at: at(2, 6) }))).toMatch(/not ready/);
    state = nextTurn(state);
    state = must(state, cast("chart_a_course", { at: at(2, 6) }));
    expect(unit(state, "ann").conditions.filter((c) => c.kind === "charted")).toHaveLength(1);
    expect(chartOf(unit(state, "ann"))).toEqual(at(2, 6));
    for (let turn = 1; turn <= 4; turn++) state = nextTurn(state);
    expect(chartOf(unit(state, "ann"))).toBeDefined();
    state = nextTurn(state);
    expect(chartOf(unit(state, "ann"))).toBeUndefined();
    expect(state.encounter!.budgets.bo.course).toBeUndefined();
  });

  it("North Star: strikes and lights every enemy beside the ally, then the ally's blows set what they hit Burning", () => {
    let { state, foes } = party([at(9, 6), at(8, 7), at(12, 10)]);
    state = must(state, cast("north_star", { target: "bo" }));
    expect(unit(state, "ann").cooldowns.north_star).toBe(4);
    for (const id of foes.slice(0, 2)) {
      expect(hurt(state, id)).toBeGreaterThan(0);
      expect(has(state, id, "guiding_light")).toBe(true);
      // The star's own blow sets nothing alight.
      expect(has(state, id, "burning")).toBe(false);
    }
    expect(hurt(state, foes[2])).toBe(0);
    expect(unit(state, "bo").conditions.find((c) => c.kind === "north_star")?.rounds).toBe(3);
    // Lit, the blow has advantage; landed, the target burns.
    let burned = false;
    for (let seed = 1; seed < 20 && !burned; seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "bo", unit: "bo", ability: "bash", target: foes[0] }, events);
      if (events.some((e) => e.t === "hit" && e.what === "bash")) burned = has(next, foes[0], "burning");
    }
    expect(burned).toBe(true);
  });

  it("North Star: a blow that would set a fire anyway sets one more stack, and each stack burns", () => {
    const { state, foes } = party();
    const ctx: Ctx = { state, rng: makeRng(3), events: [], effects: [] };
    const target = unit(state, foes[0]);
    kindle(ctx, unit(state, "bo"), target, 3);
    expect(burnOf(target)).toBe(EFFECT_TICK.burning);
    addCondition(ctx, unit(state, "bo"), "north_star", 3);
    damage(ctx, target, 1, { actor: "bo", what: "bash" });
    expect(burnOf(target)).toBe(EFFECT_TICK.burning);
    kindle(ctx, unit(state, "bo"), target, 3);
    expect(burnOf(target)).toBe(2 * EFFECT_TICK.burning!);
  });
});

describe("the Warden's wall", () => {
  const ALL = ["against_the_waves", "overwhelm", "fortify", "bulwark_strike", "taunt"];
  /**
   * A Warden (ann) with a crewmate (bo, a Mage) in a fight with `foes` (dummies with HP to spare, unless `kind` says
   * otherwise). The two heroes share one turn, and it is theirs. `edit` changes the board first.
   */
  function party(foes: HexPos[] = [at(6, 6)], opts: { bo?: HexPos; kind?: string; edit?: (t: Tile) => void } = {}) {
    let state = board(opts.edit);
    state.aiOff = true;
    hero(state, "ann", "sre_warden", at(5, 6)).abilities = ["sturdy_blow", ...ALL];
    hero(state, "bo", "devops_mage", opts.bo ?? at(3, 8));
    const ids = foes.map((pos) => {
      const e = enemy(state, opts.kind ?? "dummy", pos);
      e.hp = e.maxHp = 500;
      return e.id;
    });
    state = provoke(state);
    const enc = state.encounter!;
    enc.order = ["ann", "bo", ...ids];
    Object.assign(enc.init, { ann: 20, bo: 19 }, Object.fromEntries(ids.map((id) => [id, 1])));
    while (!["ann", "bo"].every((id) => state.encounter!.acting.includes(id))) state = must(state, { type: "timeout" });
    return { state, foes: ids };
  }
  const rock = (...hexes: HexPos[]) => (t: Tile) => { if (hexes.some((p) => p.q === t.q && p.r === t.r)) t.biome = "rock"; };

  it("are all in the Warden's pool, and on none of its weapons", () => {
    expect(poolFor("sre_warden").map((e) => e.id)).toEqual(ALL);
    for (const w of ["pager_axe", "maul", "boarding_pike"]) expect(WEAPONS[w].abilities.some((a) => ALL.includes(a)), w).toBe(false);
  });

  it("Endure: a Bonus action, 2 turns to wait; a high shield on the Warden, and Guarded, the same in water or out", () => {
    let { state } = party();
    expect(ABILITIES.against_the_waves.name).toBe("Endure");
    state = must(state, use("against_the_waves"));
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    expect(unit(state, "ann").cooldowns.against_the_waves).toBe(3);
    expect(shieldOf(unit(state, "ann"))).toBe(ENDURE.shield + 1);
    expect(has(state, "ann", "guarded")).toBe(true);
    expect(shieldOf(unit(state, "bo"))).toBe(0);
    ({ state } = party());
    state = paint(state, "water", [at(5, 6)]);
    state = must(state, use("against_the_waves"));
    expect(shieldOf(unit(state, "ann"))).toBe(ENDURE.shield + 1);
  });

  /** Overwhelm tried over seeds until the contest goes one way or the other. */
  function overwhelmed(won: boolean, foes: HexPos[], opts: Parameters<typeof party>[1] = {}) {
    for (let seed = 1; seed < 80; seed++) {
      let { state, foes: ids } = party(foes, opts);
      state.rng = seed;
      const events: ZoneEvent[] = [];
      state = must(state, use("overwhelm", { target: ids[0] }), events);
      const lost = events.some((e) => e.t === "miss" && e.what === "overwhelm");
      if (lost !== won) return { state, ids, events };
    }
    throw new Error("the contest never went that way");
  }

  it("Overwhelm: a Bonus action, 2 turns to wait; won, the enemy beside you is driven 2 hexes straight back", () => {
    const { state, ids } = overwhelmed(true, [at(6, 6)]);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    expect(unit(state, "ann").cooldowns.overwhelm).toBe(3);
    expect(unit(state, ids[0]).pos).toEqual(at(8, 6));
    expect(has(state, ids[0], "stunned")).toBe(false);
    // Lost, it stands its ground.
    const lost = overwhelmed(false, [at(6, 6)]);
    expect(unit(lost.state, lost.ids[0]).pos).toEqual(at(6, 6));
    // Only an enemy beside you.
    const { state: far, foes } = party([at(7, 6)]);
    expect(fails(far, use("overwhelm", { target: foes[0] }))).toMatch(/next to/);
  });

  it("Overwhelm: driven into rock, or a wall, it is Stunned and loses its next turn; onto a hex with room it shares it, and at a full one it just stops", () => {
    const flat = overwhelmed(true, [at(6, 6)], { edit: rock(at(7, 6)) });
    expect(unit(flat.state, flat.ids[0]).pos).toEqual(at(6, 6));
    expect(has(flat.state, flat.ids[0], "stunned")).toBe(true);
    const events: ZoneEvent[] = [];
    nextTurn(flat.state, events);
    expect(events.some((e) => e.t === "skip" && e.id === flat.ids[0])).toBe(true);
    // A hex, then the rock.
    const one = overwhelmed(true, [at(6, 6)], { edit: rock(at(8, 6)) });
    expect(unit(one.state, one.ids[0]).pos).toEqual(at(7, 6));
    expect(has(one.state, one.ids[0], "stunned")).toBe(true);
    // Onto another enemy's hex: there is room for two, so it is driven the whole way.
    const shared = overwhelmed(true, [at(6, 6), at(8, 6)]);
    expect(unit(shared.state, shared.ids[0]).pos).toEqual(at(8, 6));
    expect(has(shared.state, shared.ids[0], "stunned")).toBe(false);
    // Up against a hex that is full: no further, and no stun.
    const body = overwhelmed(true, [at(6, 6), at(8, 6), at(8, 6)]);
    expect(unit(body.state, body.ids[0]).pos).toEqual(at(7, 6));
    expect(has(body.state, body.ids[0], "stunned")).toBe(false);
  });

  it("Fortify: an Action, 5 hexes, 3 turns to wait; a wall of 3 hexes, broadside on to the Warden, that nobody walks through", () => {
    let { state, foes } = party([at(12, 6)]);
    state = must(state, use("fortify", { at: at(8, 6) }));
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - ACTION_AP });
    expect(unit(state, "ann").cooldowns.fortify).toBe(4);
    const wall = state.weather!.find((w) => w.kind === "wall")!;
    expect(wall.hexes).toHaveLength(3);
    expect(wall.hexes).toContainEqual(at(8, 6));
    for (const p of wall.hexes) {
      expect(hexDistance(p, at(8, 6))).toBeLessThanOrEqual(1);
      // Broadside on: every hex of it as far from the Warden as the one aimed at.
      expect(hexDistance(p, at(5, 6))).toBe(3);
      for (const u of [unit(state, "ann"), unit(state, foes[0])]) expect(stepCost(state, u, { q: p.q - 1, r: p.r }, p).cost).toBe(Infinity);
    }
    // Out of reach, and nowhere to raise it.
    expect(fails(state, use("fortify", { at: at(11, 6) }))).toMatch(/Out of range/);
    ({ state } = party([at(8, 6)]));
    expect(fails(state, use("fortify", { at: at(8, 6) }))).toMatch(/room/);
  });

  it("Fortify: the Warden's side sees over it and is steadier beside it; the enemy sees nothing through it and is no steadier", () => {
    let { state, foes } = party([at(10, 6)], { bo: at(7, 6) });
    const before = { bo: defenceOf(unit(state, "bo"), state), foe: defenceOf(unit(state, foes[0]), state) };
    state = must(state, use("fortify", { at: at(8, 6) }));
    expect(defenceOf(unit(state, "bo"), state)).toBe(before.bo + 1);
    // Walk the dummy up to the far side of it: no steadier there.
    unit(state, foes[0]).pos = at(9, 6);
    expect(defenceOf(unit(state, foes[0]), state)).toBe(before.foe);
    expect(seesFor(state, "hero", at(5, 6), at(11, 6))).toBe(true);
    expect(seesFor(state, "enemy", at(11, 6), at(5, 6))).toBe(false);
  });

  it("Fortify: the wall comes down after its rounds", () => {
    let { state } = party([at(12, 6)]);
    state = must(state, use("fortify", { at: at(8, 6) }));
    // The round it goes up in, and 3 more.
    for (let i = 0; i < 4; i++) {
      expect(state.weather!.some((w) => w.kind === "wall")).toBe(true);
      state = nextTurn(state);
    }
    expect(state.weather!.some((w) => w.kind === "wall")).toBe(false);
  });

  it("an enemy shooter cannot see a hero behind the wall to shoot", () => {
    // An archer in a hollow it cannot climb out of (it may shoot, but not go round), the Mage far out of its range.
    const pit = (t: Tile) => { if (hexDistance(t, at(11, 6)) === 1) t.elev = 2; };
    const shotAtAnn = (wall: boolean) => {
      let { state, foes } = party([at(11, 6)], { kind: "archer", bo: at(0, 11), edit: pit });
      if (wall) state = must(state, use("fortify", { at: at(7, 6) }));
      state.aiOff = false;
      const events: ZoneEvent[] = [];
      nextTurn(state, events);
      return events.some((e) => e.t === "roll" && e.roll.id === foes[0] && e.roll.target === "ann");
    };
    expect(shotAtAnn(false)).toBe(true);
    expect(shotAtAnn(true)).toBe(false);
  });

  it("Bulwark Strike: an Action, 2 turns to wait; shields first, on top of what is there, then hits harder for the shield", () => {
    const blow = (shield: number) => {
      for (let seed = 1; seed < 60; seed++) {
        let { state, foes } = party();
        state.rng = seed;
        if (shield > 0) unit(state, "ann").conditions.push({ kind: "bolstered", rounds: 2, amount: shield });
        const events: ZoneEvent[] = [];
        state = must(state, use("bulwark_strike", { target: foes[0] }), events);
        expect(unit(state, "ann").cooldowns.bulwark_strike).toBe(3);
        expect(shieldOf(unit(state, "ann"))).toBe(shield + 4 + 1);
        const hit = events.find((e) => e.t === "hit" && e.what === "bulwark_strike");
        if (hit?.t === "hit" && !hit.crit) return { seed, amount: hit.amount };
      }
      throw new Error("never landed");
    };
    const bare = blow(0);
    const braced = blow(20);
    expect(braced.seed).toBe(bare.seed);
    expect(braced.amount - bare.amount).toBe(Math.floor((20 + 5) / 2) - Math.floor(5 / 2));
  });

  it("Taunt: 2 AP, 3 turns to wait; every enemy within 2 hexes of the Warden is Taunted by them for 2 of its turns", () => {
    let { state, foes } = party([at(6, 6), at(7, 6), at(8, 6)]);
    state = must(state, use("taunt"));
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - ACTION_AP });
    expect(unit(state, "ann").cooldowns.taunt).toBe(4);
    for (const id of foes.slice(0, 2)) expect(unit(state, id).conditions.find((c) => c.kind === "taunted")).toMatchObject({ rounds: 2, by: "ann" });
    expect(has(state, foes[2], "taunted")).toBe(false);
    state = nextTurn(state);
    expect(has(state, foes[0], "taunted")).toBe(true);
    state = nextTurn(state);
    expect(has(state, foes[0], "taunted")).toBe(false);
    ({ state } = party([at(8, 6)]));
    expect(fails(state, use("taunt"))).toMatch(/within 2 hexes/);
  });

  it("Taunt: a Taunted enemy goes for the Warden over a softer target it would rather hit, and for anyone else only if it cannot", () => {
    const swings = (hide: boolean) => {
      const targets = new Set<string>();
      for (let seed = 1; seed < 12; seed++) {
        // The bandit stands between the Warden and the Mage, beside both.
        let { state, foes } = party([at(6, 6)], { kind: "bandit", bo: at(7, 6) });
        state.rng = seed;
        state = must(state, use("taunt"));
        if (hide) unit(state, "ann").conditions.push({ kind: "invisible", rounds: 3 });
        state.aiOff = false;
        const events: ZoneEvent[] = [];
        nextTurn(state, events);
        for (const e of events) if (e.t === "roll" && e.roll.kind === "attack" && e.roll.id === foes[0]) targets.add(e.roll.target!);
      }
      return targets;
    };
    expect(swings(false)).toEqual(new Set(["ann"]));
    // The Warden Unseen: there is nobody to go for but the Mage.
    expect(swings(true)).toEqual(new Set(["bo"]));
  });
});

describe("the Warlock's drowning", () => {
  const ALL = ["curse_of_drowning", "summon_sunken_sailors", "red_sky_at_morning", "unholy_waters", "the_black_spot"];
  /**
   * A Warlock (ann) with a crewmate (bo, a Mage) in a fight with `foes` (dummies with HP to spare, unless `kind` says
   * otherwise). The two heroes share one turn, and it is theirs.
   */
  function party(foes: HexPos[] = [at(8, 6)], opts: { bo?: HexPos; kind?: string } = {}) {
    let state = board();
    state.aiOff = true;
    hero(state, "ann", "data_warlock", at(5, 6)).abilities = ["hex", ...ALL];
    hero(state, "bo", "devops_mage", opts.bo ?? at(3, 8));
    const ids = foes.map((pos) => {
      const e = enemy(state, opts.kind ?? "dummy", pos);
      e.hp = e.maxHp = 500;
      return e.id;
    });
    state = provoke(state);
    const enc = state.encounter!;
    enc.order = ["ann", "bo", ...ids];
    Object.assign(enc.init, { ann: 20, bo: 19 }, Object.fromEntries(ids.map((id) => [id, 1])));
    while (!["ann", "bo"].every((id) => state.encounter!.acting.includes(id))) state = must(state, { type: "timeout" });
    return { state, foes: ids };
  }
  const cond = (state: ZoneState, id: string, kind: string) => unit(state, id).conditions.find((c) => c.kind === kind);
  const stacks = (state: ZoneState, id: string) => cond(state, id, "drowning")?.amount ?? 0;
  const sailors = (state: ZoneState) => state.units.filter((u) => u.summon?.by === "ann");

  it("are all in the Warlock's pool", () => {
    expect(poolFor("data_warlock").map((e) => e.id)).toEqual(ALL);
    for (const id of ALL) expect(TACTICS[id], id).toBeDefined();
  });

  it("Curse of Drowning: a Bonus action, 5 hexes, 3 turns to wait; struck without a roll, Slowed, and cursed for 3 of its turns", () => {
    let { state, foes } = party();
    const events: ZoneEvent[] = [];
    state = must(state, use("curse_of_drowning", { target: foes[0] }), events);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    expect(unit(state, "ann").cooldowns.curse_of_drowning).toBe(4);
    expect(events.some((e) => e.t === "roll" && e.roll.id === "ann")).toBe(false);
    expect(events.some((e) => e.t === "hit" && e.what === "curse_of_drowning" && e.target === foes[0])).toBe(true);
    expect(has(state, foes[0], "slowed")).toBe(true);
    expect(cond(state, foes[0], "drowning_curse")).toMatchObject({ rounds: 3, by: "ann" });
    // Out of water it drowns no more for it.
    state = nextTurn(state);
    expect(stacks(state, foes[0])).toBe(0);
    // Too far.
    ({ state, foes } = party([at(11, 6)]));
    expect(fails(state, use("curse_of_drowning", { target: foes[0] }))).toMatch(/Out of range/);
  });

  it("Curse of Drowning: a stack each time the enemy starts, and each time it ends, a turn in water, for as long as the curse lasts", () => {
    let { state, foes } = party();
    state = paint(state, "water", [at(8, 6)]);
    state = must(state, use("curse_of_drowning", { target: foes[0] }));
    // Its first turn: one for starting it in water, one for ending it there.
    state = nextTurn(state);
    expect(stacks(state, foes[0])).toBe(2);
    state = nextTurn(state);
    expect(stacks(state, foes[0])).toBe(4);
    // Its third and last cursed turn still counts at the end.
    state = nextTurn(state);
    expect(stacks(state, foes[0])).toBe(6);
    expect(has(state, foes[0], "drowning_curse")).toBe(false);
    state = nextTurn(state);
    expect(stacks(state, foes[0])).toBe(6);
  });

  it("Drowning: HP lost for every stack at the start of its turn, then a breath held against a low mark that every stack raises", () => {
    let { state, foes } = party();
    unit(state, foes[0]).conditions.push({ kind: "drowning", rounds: 3, amount: 3 });
    const events: ZoneEvent[] = [];
    state = nextTurn(state, events);
    expect(events.find((e) => e.t === "tick" && e.kind === "drowning")).toMatchObject({ target: foes[0], amount: 2 * 3 });
    const breath = events.find((e) => e.t === "roll" && e.roll.kind === "save" && e.roll.id === foes[0]);
    expect(breath?.t === "roll" && breath.roll.vs).toBe(2 + 2 * 3);
    // No new stack: it runs down, and is gone after its third turn.
    expect(cond(state, foes[0], "drowning")).toMatchObject({ rounds: 2, amount: 3 });
    state = nextTurn(nextTurn(state));
    expect(has(state, foes[0], "drowning")).toBe(false);
  });

  it("Drowning: a breath not held costs 2 AP, one attack of the two", () => {
    /** A bandit beside the Warlock, drowning deep, its turn played over seeds until the breath goes the way asked. */
    const turn = (held: boolean) => {
      for (let seed = 1; seed < 80; seed++) {
        let { state, foes } = party([at(6, 6)], { kind: "bandit" });
        unit(state, foes[0]).conditions.push({ kind: "drowning", rounds: 3, amount: 4 });
        // With the AI off it has saved its AP so far: a turn with just the AP_TURN it is given.
        delete state.encounter!.banked;
        state.aiOff = false;
        state.rng = seed;
        const events: ZoneEvent[] = [];
        nextTurn(state, events);
        const choked = events.some((e) => e.t === "choked" && e.id === foes[0]);
        if (choked !== held) return events.filter((e) => e.t === "roll" && e.roll.kind === "attack" && e.roll.id === foes[0]).length;
      }
      throw new Error("the breath never went that way");
    };
    expect(turn(true)).toBe(2);
    expect(turn(false)).toBe(1);
  });

  it("The Black Spot: an Action, 4 turns to wait; no roll; the enemy attacks with disadvantage, and drowns a stack deeper at the end of each of 4 turns", () => {
    let { state, foes } = party();
    const events: ZoneEvent[] = [];
    state = must(state, use("the_black_spot", { target: foes[0] }), events);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - ACTION_AP });
    expect(unit(state, "ann").cooldowns.the_black_spot).toBe(5);
    expect(events.some((e) => e.t === "roll" && e.roll.id === "ann")).toBe(false);
    expect(cond(state, foes[0], "black_spot")).toMatchObject({ rounds: 4, by: "ann" });
    expect(attackContext(state, unit(state, foes[0]), unit(state, "ann"), { melee: false }).adv).toBe(-1);
    for (let turn = 1; turn <= 4; turn++) {
      state = nextTurn(state);
      // Every stack laid on starts the count again for all of them.
      expect(cond(state, foes[0], "drowning")).toMatchObject({ rounds: 3, amount: turn });
    }
    expect(has(state, foes[0], "black_spot")).toBe(false);
    state = nextTurn(state);
    expect(cond(state, foes[0], "drowning")).toMatchObject({ rounds: 2, amount: 4 });
  });

  it("The Black Spot: one that falls with it on passes it to the nearest of its side, for what it had left", () => {
    let { state, foes } = party([at(8, 6), at(10, 6), at(13, 6)]);
    state = must(state, use("the_black_spot", { target: foes[0] }));
    state = nextTurn(state);
    const ctx: Ctx = { state, rng: makeRng(1), events: [], effects: [] };
    damage(ctx, unit(state, foes[0]), 999, { actor: "ann", what: "hex" });
    expect(has(state, foes[0], "black_spot")).toBe(false);
    expect(cond(state, foes[1], "black_spot")).toMatchObject({ rounds: 3, by: "ann" });
    expect(has(state, foes[2], "black_spot")).toBe(false);
    // And on again from that one.
    damage(ctx, unit(state, foes[1]), 999, { actor: "ann", what: "hex" });
    expect(cond(state, foes[2], "black_spot")).toMatchObject({ rounds: 3, by: "ann" });
    // The last of them takes it to the grave.
    damage(ctx, unit(state, foes[2]), 999, { actor: "ann", what: "hex" });
    expect(state.units.some((u) => u.conditions.some((c) => c.kind === "black_spot"))).toBe(false);
  });

  it("Red Sky at Morning: an Action, 5 hexes, 5 turns to wait; every enemy within 2 of the hex attacks with disadvantage for 3 turns, nobody else", () => {
    let { state, foes } = party([at(8, 6), at(9, 7), at(12, 6)], { bo: at(7, 6) });
    const ap = state.encounter!.budgets.ann.ap;
    state = must(state, use("red_sky_at_morning", { at: at(9, 6) }));
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: ap - ACTION_AP });
    expect(unit(state, "ann").cooldowns.red_sky_at_morning).toBe(6);
    expect(cond(state, foes[0], "red_sky")).toMatchObject({ rounds: 3 });
    expect(has(state, foes[1], "red_sky")).toBe(true);
    expect(has(state, foes[2], "red_sky")).toBe(false);
    expect(has(state, "bo", "red_sky")).toBe(false);
    expect(attackContext(state, unit(state, foes[0]), unit(state, "bo"), { melee: true }).adv).toBe(-1);
    expect(fails(state, { ...use("red_sky_at_morning", { at: at(11, 6) }) })).toMatch(/Out of range/);
  });

  it("Unholy Waters: a Bonus action, 5 hexes, 2 turns to wait; water over 7 hexes, but fire under each enemy in them", () => {
    let { state, foes } = party([at(8, 6), at(9, 6)], { bo: at(7, 6) });
    // Water already under one of them: it still comes up burning.
    state = paint(state, "water", [at(9, 6)]);
    const events: ZoneEvent[] = [];
    state = must(state, use("unholy_waters", { at: at(8, 6) }), events);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    expect(unit(state, "ann").cooldowns.unholy_waters).toBe(3);
    const kind = (p: HexPos) => state.surfaces[posKey(p)]?.kind;
    expect(kind(at(8, 6))).toBe("fire");
    expect(kind(at(9, 6))).toBe("fire");
    for (const p of blast(state.map, at(8, 6), 1).filter((p) => !foes.some((id) => posKey(unit(state, id).pos) === posKey(p)))) expect(kind(p), posKey(p)).toBe("water");
    expect(state.surfaces[posKey(at(7, 6))]).toMatchObject({ kind: "water", rounds: 3 });
    expect(state.surfaces[posKey(at(8, 6))]).toMatchObject({ kind: "fire", rounds: 2 });
    for (const id of foes) expect(events.some((e) => e.t === "tick" && e.kind === "fire" && e.target === id), id).toBe(true);
    expect(has(state, "bo", "wet")).toBe(true);
  });

  it("Summon Sunken Sailors: an Action, 4 turns to wait; a cutlass on the hex picked and a gunner beside it, nearer the Warlock, both played by its player", () => {
    let { state, foes } = party([at(13, 6)]);
    state = must(state, use("summon_sunken_sailors", { at: at(8, 6) }));
    expect(unit(state, "ann").cooldowns.summon_sunken_sailors).toBe(5);
    const [cutlass, gunner] = sailors(state);
    expect(cutlass).toMatchObject({ kind: "drowned_cutlass", controller: "ann", pos: at(8, 6) });
    expect(gunner).toMatchObject({ kind: "drowned_gunner", controller: "ann", pos: at(7, 6) });
    // The cutlass stands up to more and hits harder; the gunner's pistol reaches 4 hexes.
    expect(cutlass.maxHp).toBeGreaterThan(gunner.maxHp);
    expect(defenceOf(cutlass)).toBeGreaterThan(defenceOf(gunner));
    expect(abilityDiceOf("sailor_pistol")).toEqual({ n: 1, d: 6, plus: 2 });
    expect(diceAverage(abilityDiceOf("sailor_scimitar"))).toBeGreaterThan(diceAverage(abilityDiceOf("sailor_pistol")));
    expect(TACTICS.sailor_pistol).toMatchObject({ reach: "ranged", range: 4 });
    expect(TACTICS.sailor_scimitar).toMatchObject({ reach: "melee" });
    // Straight after the Warlock in the order, in the turn they share.
    const enc = state.encounter!;
    expect(enc.order.slice(enc.order.indexOf("ann") + 1, enc.order.indexOf("ann") + 3)).toEqual([cutlass.id, gunner.id]);
    for (const s of [cutlass, gunner]) expect(enc.budgets[s.id]).toMatchObject({ ap: SUMMON_AP_TURN, move: 0, stride: 2 });
    expect(fails(state, { type: "use", by: "ann", unit: gunner.id, ability: "sailor_pistol", target: foes[0] })).toMatch(/Out of range/);
    state = must(state, { type: "move", by: "ann", unit: gunner.id, to: at(9, 6) });
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: gunner.id, ability: "sailor_pistol", target: foes[0] }, events);
    expect(events.some((e) => e.t === "roll" && e.roll.id === gunner.id)).toBe(true);
  });

  it("Summon Sunken Sailors: room is needed for both; calling them again sends the first two away", () => {
    let { state } = party([at(13, 6)]);
    // Rock all round the hex but one side, and that side is the Mage's: no room for the second.
    const walled = party([at(13, 6)], { bo: at(6, 6) }).state;
    // (New tiles in a new array: a state's tiles are shared from step to step, so one is never changed where it lies.)
    const round = new Set(hexNeighbors(at(7, 6), walled.map.grid).map(posKey).filter((key) => key !== posKey(at(6, 6))));
    walled.map.tiles = walled.map.tiles.map((t) => (round.has(posKey(t)) ? { ...t, biome: "rock" } : t));
    expect(fails(walled, use("summon_sunken_sailors", { at: at(7, 6) }))).toMatch(/room for them all/);
    state = must(state, use("summon_sunken_sailors", { at: at(8, 6) }));
    const first = sailors(state).map((u) => u.id);
    for (let i = 0; i < 5; i++) state = nextTurn(state);
    // Again, on the very hex one of the first two holds: they are going, so there is room.
    const events: ZoneEvent[] = [];
    state = must(state, use("summon_sunken_sailors", { at: at(8, 6) }), events);
    expect(sailors(state)).toHaveLength(2);
    for (const id of first) {
      expect(events.some((e) => e.t === "dismissed" && e.id === id)).toBe(true);
      expect(state.encounter!.order).not.toContain(id);
    }
  });
});

/** An ability's damage dice, from its content. */
const abilityDiceOf = (id: string) => abilityDiceFor(ABILITIES[id]);

describe("Paladin weapons", () => {
  it("gives each weapon two abilities of its own, the second once a turn", () => {
    expect(WEAPONS.mace.abilities).toEqual(["bash", "recover"]);
    expect(WEAPONS.greatsword.abilities).toEqual(["cleave", "block"]);
    expect(WEAPONS.ballast_flail.abilities).toEqual(["flail_strike", "armor_crush"]);
    for (const id of ["bash", "recover", "cleave", "block", "flail_strike", "armor_crush"]) expect(tacticOf(id).cooldown, id).toBe(Object.values(WEAPONS).some((w) => w.abilities[0] === id) ? undefined : 1);
    expect(ABILITIES.bash.perfect).toEqual({ effect: "prone", turns: 1 });
    expect(ABILITIES.flail_strike.perfect).toEqual({ effect: "slowed", turns: 2 });
    expect(ABILITIES.armor_crush.perfect).toEqual({ effect: "sundered", turns: 2 });
  });

  it("Cleave: swings through the three hexes beside you on the side aimed at, however far off the aim", () => {
    const { state, foe } = duel("dummy", "qa_paladin", at(5, 6), at(7, 6));
    const ann = unit(state, "ann");
    ann.abilities = ["cleave"];
    for (const aim of [unit(state, foe).pos, at(12, 6)]) {
      const area = abilityArea(state, ann, "cleave", aim);
      expect(area).toHaveLength(3);
      for (const p of area) expect(hexDistance(p, ann.pos)).toBe(1);
      expect(area.map(posKey)).toContain(posKey(unit(state, foe).pos));
    }
    expect(checkAbility(state, ann, "cleave", { at: unit(state, foe).pos })).toBeNull();
    expect(checkAbility(state, ann, "cleave", { at: at(3, 6) })).toMatch(/No enemy is in that swing/);
    expect(checkAbility(state, ann, "cleave", {})).toMatch(/which way/);
  });

  it("Bash with the Action and Armor Crush with the Bonus action, both in one turn", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(5, 6), at(7, 6));
    unit(state, "ann").abilities = ["bash", "armor_crush"];
    expect(tacticOf("armor_crush").cost).toBe(BONUS_AP);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bash", target: foe });
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "armor_crush", target: foe });
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - ACTION_AP - BONUS_AP });
  });

  it("Recover heals and Block shields, 1 AP each, both in one turn", () => {
    let { state } = duel("dummy", "qa_paladin", at(5, 6), at(7, 6));
    unit(state, "ann").abilities = ["recover", "block"];
    unit(state, "ann").hp = 5;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "recover" });
    expect(unit(state, "ann").hp).toBeGreaterThan(5);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "block" });
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - 2 * BONUS_AP });
    state = duel("dummy", "qa_paladin", at(5, 6), at(7, 6)).state;
    unit(state, "ann").abilities = ["block"];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "block" });
    expect(shieldOf(unit(state, "ann"))).toBe(BLOCK.shield + unit(state, "ann").level);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
  });

  it("Sundered takes Defence off", () => {
    const { state, foe } = duel("dummy", "qa_paladin", at(5, 6), at(7, 6));
    const target = unit(state, foe);
    const before = defenceOf(target, state);
    const ctx: Ctx = { state, rng: makeRng(1), events: [], effects: [] };
    addCondition(ctx, target, "sundered", 2);
    expect(defenceOf(target, state)).toBe(before - SUNDERED_DEFENCE);
  });
});

describe("Mage weapons", () => {
  it("gives each weapon two abilities of its own, the second once a turn (Lightning Strike every other turn)", () => {
    expect(WEAPONS.staff.abilities).toEqual(["shock", "mend"]);
    expect(WEAPONS.tome.abilities).toEqual(["slicing_wind", "winds_blessing"]);
    expect(WEAPONS.barometer_rod.abilities).toEqual(["waterbolt", "lightning_strike"]);
    for (const id of ["shock", "mend", "slicing_wind", "winds_blessing", "waterbolt"]) expect(tacticOf(id).cooldown, id).toBe(Object.values(WEAPONS).some((w) => w.abilities[0] === id) ? undefined : 1);
    expect(tacticOf("lightning_strike").cooldown).toBe(2);
    // Lightning hits harder on the Wet, and a Waterbolt leaves them Wet.
    expect(tacticOf("shock").vsWet).toBeGreaterThan(0);
    expect(tacticOf("lightning_strike").vsWet).toBeGreaterThan(0);
    expect(tacticOf("waterbolt").surface?.kind).toBe("water");
    expect(ABILITIES.lightning_strike.perfect).toEqual({ effect: "stunned", turns: 1 });
    expect(tacticOf("mend").cost).toBe(ACTION_AP);
    expect(tacticOf("winds_blessing").cost).toBe(BONUS_AP);
  });

  it("Slicing Wind: the Mage gets a hex more for each AP of movement this turn, hit or miss", () => {
    let { state, foe } = duel("dummy", "devops_mage", at(5, 6), at(8, 6));
    unit(state, "ann").abilities = ["slicing_wind"];
    const stride = state.encounter!.budgets.ann.stride;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "slicing_wind", target: foe });
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - ACTION_AP, stride: stride + 1 });
  });

  it("Wind's Blessing: one more movement for each AP now on yourself, else on the ally's next turn", () => {
    let { state } = duel("dummy", "devops_mage", at(5, 6), at(8, 6));
    unit(state, "ann").abilities = ["winds_blessing"];
    const stride = state.encounter!.budgets.ann.stride;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "winds_blessing", target: "ann" });
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP, stride: stride + 1 });
    expect(unit(state, "ann").conditions.some((c) => c.kind === "tailwind")).toBe(false);

    // An ally whose turn is over carries it to their next.
    state = board();
    state.aiOff = true;
    hero(state, "ann", "devops_mage", at(5, 6)).abilities = ["winds_blessing"];
    hero(state, "bo", "qa_paladin", at(4, 6));
    enemy(state, "dummy", at(9, 6));
    state = provoke(state);
    while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" });
    if (state.encounter!.acting.includes("bo") && !state.encounter!.done.includes("bo")) state = must(state, { type: "end_turn", by: "bo", unit: "bo" });
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "winds_blessing", target: "bo" });
    expect(unit(state, "bo").conditions.find((c) => c.kind === "tailwind")?.amount).toBe(1);
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    while (!state.encounter!.acting.includes("bo") || state.encounter!.done.includes("bo")) state = must(state, { type: "timeout" });
    const budget = state.encounter!.budgets.bo;
    expect(budget.stride).toBe(heroMove(unit(state, "bo").stats!) + 1);
  });

  it("Waterbolt: a hit leaves water under the target, and soaks it", () => {
    let { state, foe } = duel("dummy", "devops_mage", at(5, 6), at(8, 6));
    unit(state, "ann").abilities = ["waterbolt"];
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "waterbolt", target: foe }, events);
    const hit = events.some((e) => e.t === "hit" && e.target === foe);
    expect(state.surfaces[posKey(unit(state, foe).pos)]?.kind === "water").toBe(hit);
    expect(unit(state, foe).conditions.some((c) => c.kind === "wet")).toBe(hit);
  });
});

describe("Rogue weapons", () => {
  it("gives each weapon two abilities of its own, the second once a turn, Eviscerate longer", () => {
    expect(WEAPONS.daggers.abilities).toEqual(["stab", "eviscerate"]);
    expect(WEAPONS.shortbow.abilities).toEqual(["bow_shot", "take_aim"]);
    expect(WEAPONS.gaff_hook.abilities).toEqual(["tear", "snag"]);
    for (const id of ["stab", "bow_shot", "take_aim", "tear", "snag"]) expect(tacticOf(id).cooldown, id).toBe(Object.values(WEAPONS).some((w) => w.abilities[0] === id) ? undefined : 1);
    expect(tacticOf("eviscerate").cooldown).toBe(3);
    expect(tacticOf("take_aim").cost).toBe(BONUS_AP);
    expect(tacticOf("stab").edge).toBeGreaterThan(0);
    expect(ABILITIES.tear.perfect).toEqual({ effect: "bleeding", turns: 3 });
    expect(ABILITIES.snag.perfect).toEqual({ effect: "slowed", turns: 2 });
  });

  it("Take Aim: the next roll to hit has advantage, and is spent by it", () => {
    let { state, foe } = duel("dummy", "refactor_rogue", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["take_aim", "bow_shot"];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "take_aim" });
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    expect(unit(state, "ann").conditions.some((c) => c.kind === "inspired")).toBe(true);
    const events: ZoneEvent[] = [];
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bow_shot", target: foe }, events);
    const roll = events.find((e) => e.t === "roll" && e.roll.kind === "attack");
    expect(roll?.t === "roll" && roll.roll.adv).toBe(1);
    expect(unit(state, "ann").conditions.some((c) => c.kind === "inspired")).toBe(false);
  });

  it("Eviscerate: a hit leaves the target Bleeding unless it saves", () => {
    const { state, foe } = duel("dummy", "refactor_rogue", at(5, 6), at(7, 6));
    unit(state, "ann").abilities = ["eviscerate"];
    const after = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "eviscerate", target: foe }, foe);
    const save = after.events.find((e) => e.t === "roll" && e.roll.kind === "save");
    expect(save?.t === "roll" && save.roll.label).toBe("Resist Eviscerate");
    expect(unit(after.state, foe).conditions.some((c) => c.kind === "bleeding")).toBe(!(save?.t === "roll" && save.roll.ok));
  });

  it("Snag: reaches 3 hexes, leaves the target where it is, and Slows it unless it saves", () => {
    const { state, foe } = duel("dummy", "refactor_rogue", at(4, 6), at(8, 6));
    unit(state, "ann").abilities = ["snag"];
    expect(hexDistance(unit(state, "ann").pos, unit(state, foe).pos)).toBe(3);
    const where = unit(state, foe).pos;
    let slowed = false;
    let held = false;
    for (let seed = 1; seed < 120 && !(slowed && held); seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "snag", target: foe }, events);
      if (!events.some((e) => e.t === "hit" && e.target === foe)) continue;
      expect(unit(next, foe).pos).toEqual(where);
      const save = events.find((e) => e.t === "roll" && e.roll.kind === "save");
      const isSlowed = unit(next, foe).conditions.some((c) => c.kind === "slowed");
      expect(isSlowed).toBe(save?.t === "roll" && !save.roll.ok);
      if (isSlowed) slowed = true;
      else held = true;
    }
    expect(slowed && held).toBe(true);
    unit(state, foe).pos = at(9, 6);
    expect(checkAbility(state, unit(state, "ann"), "snag", { target: foe })).toMatch(/Out of range/);
  });
});

describe("Druid weapons", () => {
  const rows = (state: ZoneState, from: HexPos, toward: HexPos) => {
    const hexes = abilityArea(state, { ...unit(state, "ann"), pos: from }, "coral_burst", toward);
    return [1, 2, 3].map((n) => hexes.filter((p) => hexDistance(p, from) === n).length);
  };

  it("gives each weapon two abilities, the second once a turn, Restore longer", () => {
    expect(WEAPONS.root_staff.abilities).toEqual(["thornlash", "rejuvenate"]);
    expect(WEAPONS.sickle.abilities).toEqual(["sea_slash", "binding_kelp"]);
    expect(WEAPONS.coral_staff.abilities).toEqual(["coral_burst", "restore"]);
    for (const id of ["sea_slash", "binding_kelp", "coral_burst"]) expect(tacticOf(id).cooldown, id).toBe(Object.values(WEAPONS).some((w) => w.abilities[0] === id) ? undefined : 1);
    expect(tacticOf("restore").cooldown).toBe(2);
    expect(tacticOf("binding_kelp").cost).toBe(BONUS_AP);
    expect(tacticOf("restore").cost).toBe(BONUS_AP);
    expect(tacticOf("coral_burst").cost).toBe(ACTION_AP);
  });

  it("Coral Burst: a cone of 1 hex, then 2, then 3, whichever way it is aimed", () => {
    const state = board();
    hero(state, "ann", "backend_druid", at(8, 6)).abilities = ["coral_burst"];
    for (const to of [at(12, 6), at(4, 6), at(8, 2), at(8, 10), at(11, 3), at(10, 9), at(12, 7)]) expect(rows(state, at(8, 6), to), `${to.q},${to.r}`).toEqual([1, 2, 3]);
    // It starts beside you, in the direction aimed at, and stays one clump.
    const cone = abilityArea(state, unit(state, "ann"), "coral_burst", at(12, 6));
    expect(new Set(cone.map(posKey)).size).toBe(6);
    expect(cone.map(posKey)).toContain(posKey(at(9, 6)));
    const checked = checkAbility(state, unit(state, "ann"), "coral_burst", {});
    expect(checked).toMatch(/Pick a direction/);
  });

  it("Coral Burst: strikes only enemies in it, leaving an ally in the cone alone, and cuts those who fail to brace", () => {
    let { state, foe } = duel("dummy", "backend_druid", at(5, 6), at(7, 6));
    hero(state, "bo", "qa_paladin", at(6, 6));
    state.encounter!.acting = ["ann"];
    unit(state, "ann").abilities = ["coral_burst"];
    const bo = unit(state, "bo").hp;
    let bled = false;
    for (let seed = 1; seed < 80 && !bled; seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "coral_burst", at: unit(tryState, foe).pos }, events);
      expect(unit(next, "bo").hp).toBe(bo);
      expect(events.some((e) => e.t === "hit" && e.target === foe)).toBe(true);
      bled = unit(next, foe).conditions.some((c) => c.kind === "bleeding");
    }
    expect(bled).toBe(true);
  });

  it("Sea Slash: a hit leaves water under the target and under you", () => {
    let { state, foe } = duel("dummy", "backend_druid", at(5, 6), at(7, 6));
    unit(state, "ann").abilities = ["sea_slash"];
    const here = unit(state, "ann").pos;
    for (let seed = 1; seed < 80; seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "sea_slash", target: foe }, events);
      const hit = events.some((e) => e.t === "hit" && e.target === foe);
      expect(next.surfaces[posKey(here)]?.kind === "water").toBe(hit);
      expect(next.surfaces[posKey(unit(next, foe).pos)]?.kind === "water").toBe(hit);
      if (hit) return;
    }
    throw new Error("never landed");
  });

  it("Binding Kelp: a Bonus action at range 4, no roll to hit: Slowed on a failed save, Stunned instead if the target stands in water", () => {
    const { state, foe } = duel("dummy", "backend_druid", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["binding_kelp"];
    unit(state, foe).pos = at(9, 6);
    expect(checkAbility(state, unit(state, "ann"), "binding_kelp", { target: foe })).toBeNull();
    unit(state, foe).pos = at(11, 6);
    expect(checkAbility(state, unit(state, "ann"), "binding_kelp", { target: foe })).toMatch(/Out of range/);
    unit(state, foe).pos = at(9, 6);
    const held = (water: boolean) => {
      const s = structuredClone(state);
      if (water) s.surfaces[posKey(unit(s, foe).pos)] = { kind: "water", rounds: 5, by: null };
      let got: string | null = null;
      for (let seed = 1; seed < 80 && !got; seed++) {
        const tryState = structuredClone(s);
        tryState.rng = seed;
        const events: ZoneEvent[] = [];
        const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "binding_kelp", target: foe }, events);
        expect(events.some((e) => e.t === "roll" && e.roll.kind === "attack")).toBe(false);
        expect(next.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
        got = unit(next, foe).conditions.find((c) => c.kind === "slowed" || c.kind === "stunned")?.kind ?? null;
      }
      return got;
    };
    expect(held(false)).toBe("slowed");
    expect(held(true)).toBe("stunned");
  });

  it("Restore: heals a little and lifts every debuff, then waits a turn", () => {
    let { state } = duel("dummy", "backend_druid", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["restore"];
    unit(state, "ann").hp = 5;
    const ctx: Ctx = { state, rng: makeRng(1), events: [], effects: [] };
    for (const kind of ["bleeding", "slowed", "exposed", "sundered"] as const) addCondition(ctx, unit(state, "ann"), kind, 3);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "restore", target: "ann" });
    expect(unit(state, "ann").hp).toBeGreaterThan(5);
    expect(unit(state, "ann").conditions.filter((c) => ["bleeding", "slowed", "exposed", "sundered"].includes(c.kind))).toEqual([]);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "restore", target: "ann" })).toMatch(/not ready/);
  });
});

describe("Bard weapons", () => {
  it("gives each weapon two abilities, the second once a turn, the Pipe's Soothing Tone and the Bell's Clarion Call longer", () => {
    expect(WEAPONS.lute.abilities).toEqual(["dissonance", "encore"]);
    expect(WEAPONS.flute.abilities).toEqual(["blasting_tone", "soothing_tone"]);
    expect(WEAPONS.ships_bell.abilities).toEqual(["peal", "clarion_call"]);
    for (const id of ["dissonance", "encore", "blasting_tone", "peal"]) expect(tacticOf(id).cooldown, id).toBe(Object.values(WEAPONS).some((w) => w.abilities[0] === id) ? undefined : 1);
    expect(tacticOf("soothing_tone").cooldown).toBe(2);
    expect(tacticOf("clarion_call").cooldown).toBe(2);
    expect(tacticOf("encore").cost).toBe(BONUS_AP);
    for (const id of ["dissonance", "blasting_tone", "soothing_tone", "peal", "clarion_call", "hornpipe"]) expect(tacticOf(id).cost, id).toBe(ACTION_AP);
  });

  it("Dissonance: a hit leaves the target Fumbling, with no save, and its next attack is rolled with disadvantage", () => {
    const { state, foe } = duel("dummy", "frontend_bard", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["dissonance"];
    const after = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "dissonance", target: foe }, foe);
    expect(unit(after.state, foe).conditions.some((c) => c.kind === "glitched")).toBe(true);
    expect(unit(after.state, foe).conditions.some((c) => c.kind === "stunned")).toBe(false);
    expect(after.events.some((e) => e.t === "roll" && e.roll.kind === "save")).toBe(false);
    expect(attackContext(after.state, unit(after.state, foe), unit(after.state, "ann"), { melee: false }).adv).toBe(-1);
  });

  it("Second Wind: a Bonus action that heals a little and leaves the target's next roll to hit with advantage", () => {
    let { state, foe } = duel("dummy", "frontend_bard", at(5, 6), at(9, 6));
    hero(state, "bo", "qa_paladin", at(5, 7));
    unit(state, "ann").abilities = ["encore", "bow_shot"];
    unit(state, "ann").hp = 5;
    unit(state, "bo").hp = 5;
    const move = state.encounter!.budgets.ann.move;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "encore", target: "ann" });
    expect(unit(state, "ann").hp).toBeGreaterThan(5);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP, move });
    expect(unit(state, "ann").conditions.some((c) => c.kind === "inspired")).toBe(true);
    expect(attackContext(state, unit(state, "ann"), unit(state, foe), { melee: false }).adv).toBe(1);
    expect(unit(state, "ann").conditions.some((c) => c.kind === "tailwind" || c.kind === "hasted")).toBe(false);
  });

  it("Second Wind on an ally: they are healed and Inspired, and it is still there on their own turn", () => {
    let { state } = duel("dummy", "frontend_bard", at(5, 6), at(9, 6));
    hero(state, "bo", "qa_paladin", at(5, 7));
    unit(state, "ann").abilities = ["encore"];
    unit(state, "bo").hp = 5;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "encore", target: "bo" });
    expect(unit(state, "bo").hp).toBeGreaterThan(5);
    expect(unit(state, "bo").conditions.some((c) => c.kind === "inspired")).toBe(true);
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" });
    expect(unit(state, "bo").conditions.some((c) => c.kind === "inspired")).toBe(true);
  });

  it("Blasting Tone: a line of 4 hexes that strikes the enemies on it and spares an ally", () => {
    const { state, foe } = duel("dummy", "frontend_bard", at(5, 6), at(8, 6));
    hero(state, "bo", "qa_paladin", at(7, 6));
    unit(state, "ann").abilities = ["blasting_tone"];
    expect(abilityArea(state, unit(state, "ann"), "blasting_tone", at(12, 6))).toHaveLength(4);
    const bo = unit(state, "bo").hp;
    const events: ZoneEvent[] = [];
    const next = must(state, { type: "use", by: "ann", unit: "ann", ability: "blasting_tone", at: at(12, 6) }, events);
    expect(events.some((e) => e.t === "hit" && e.target === foe)).toBe(true);
    expect(unit(next, "bo").hp).toBe(bo);
  });

  it("Soothing Tone: heals you and every ally within 2 hexes, not one further off, then waits a turn", () => {
    let { state } = duel("dummy", "frontend_bard", at(5, 6), at(11, 6));
    hero(state, "bo", "qa_paladin", at(8, 6));
    hero(state, "cy", "refactor_rogue", at(9, 6));
    unit(state, "ann").abilities = ["soothing_tone"];
    for (const id of ["ann", "bo", "cy"]) unit(state, id).hp = 1;
    // ann is at (6, 6): bo is 2 off, cy is 3.
    expect(hexDistance(unit(state, "ann").pos, unit(state, "bo").pos)).toBe(2);
    expect(hexDistance(unit(state, "ann").pos, unit(state, "cy").pos)).toBe(3);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "soothing_tone" });
    expect(unit(state, "ann").hp).toBeGreaterThan(1);
    expect(unit(state, "bo").hp).toBeGreaterThan(1);
    expect(unit(state, "cy").hp).toBe(1);
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "soothing_tone" })).toMatch(/not ready/);
  });

  it("Peal: a hit pushes the target 1 hex back unless it saves", () => {
    const { state, foe } = duel("dummy", "frontend_bard", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["peal"];
    const from = hexDistance(unit(state, "ann").pos, unit(state, foe).pos);
    let pushed = false;
    let held = false;
    for (let seed = 1; seed < 120 && !(pushed && held); seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "peal", target: foe }, events);
      if (!events.some((e) => e.t === "hit" && e.target === foe)) continue;
      const save = events.find((e) => e.t === "roll" && e.roll.kind === "save");
      expect(save).toBeDefined();
      const now = hexDistance(unit(next, "ann").pos, unit(next, foe).pos);
      if (save?.t === "roll" && save.roll.ok) { expect(now).toBe(from); held = true; }
      else { expect(now).toBe(from + 1); pushed = true; }
    }
    expect(pushed && held).toBe(true);
  });

  it("Bellows Blast: strikes every enemy beside you, spares an ally, pushes back whoever fails to brace, then waits a turn", () => {
    let { state, foe } = duel("dummy", "frontend_bard", at(5, 6), at(7, 6));
    hero(state, "bo", "qa_paladin", at(6, 7));
    unit(state, "ann").abilities = ["bellows_blast"];
    expect(WEAPONS.accordion.abilities).toEqual(["bellows_blast", "hornpipe"]);
    expect(hexDistance(unit(state, "ann").pos, unit(state, foe).pos)).toBe(1);
    const bo = unit(state, "bo").hp;
    let pushed = false;
    let held = false;
    for (let seed = 1; seed < 120 && !(pushed && held); seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "bellows_blast" }, events);
      expect(unit(next, "bo").hp).toBe(bo);
      expect(unit(next, foe).hp).toBeLessThan(unit(state, foe).hp);
      const save = events.find((e) => e.t === "roll" && e.roll.kind === "save");
      const now = hexDistance(unit(next, "ann").pos, unit(next, foe).pos);
      if (save?.t === "roll" && save.roll.ok) { expect(now).toBe(1); held = true; }
      else { expect(now).toBe(2); pushed = true; }
    }
    expect(pushed && held).toBe(true);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "bellows_blast" });
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" });
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "bellows_blast" })).toMatch(/not ready/);
  });

  it("Hornpipe: 2 AP that Rallies the Bard and every ally within 2 hexes, then waits two turns", () => {
    let { state } = duel("dummy", "frontend_bard", at(5, 6), at(11, 6));
    // The duel has stepped Ann up to (6, 6): Bo is 1 hex off, Cy 3.
    hero(state, "bo", "qa_paladin", at(7, 6));
    hero(state, "cy", "refactor_rogue", at(9, 6));
    unit(state, "ann").abilities = ["hornpipe"];
    expect([hexDistance(unit(state, "ann").pos, unit(state, "bo").pos), hexDistance(unit(state, "ann").pos, unit(state, "cy").pos)]).toEqual([1, 3]);
    const stride = state.encounter!.budgets.ann.stride;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "hornpipe" });
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - ACTION_AP, stride });
    expect(["ann", "bo", "cy"].map((id) => has(state, id, "rallied"))).toEqual([true, true, false]);
    expect(tacticOf("hornpipe").cooldown).toBe(2);
  });

  it("Rallied: +2 damage on the next attack, then it is spent", () => {
    let { state, foe } = duel("dummy", "frontend_bard", at(5, 6), at(7, 6));
    unit(state, "ann").abilities = ["hornpipe", "dissonance"];
    unit(state, foe).hp = 999;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "hornpipe" });
    expect(has(state, "ann", "rallied")).toBe(true);
    const after = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "dissonance", target: foe }, foe);
    expect(has(after.state, "ann", "rallied")).toBe(false);
    const blow = after.events.find((e) => e.t === "hit" && e.target === foe);
    if (blow?.t !== "hit" || !blow.dice) throw new Error("no blow");
    // 1d6+2, the Bard's own bonus (INT, weapon, half level), and the Rally's +2.
    const ann = unit(after.state, "ann");
    const own = Math.floor((ann.stats!.int_stat - 5) / 2) + ann.power + Math.floor(ann.level / 2);
    expect(blow.dice.plus).toBe(2 + own + RALLY.damage);
  });

  it("Clarion Call: a good heal on the target, and a lesser one on every ally beside it, but none further off", () => {
    const { state } = duel("dummy", "frontend_bard", at(5, 6), at(11, 6));
    hero(state, "bo", "qa_paladin", at(8, 6));
    hero(state, "cy", "refactor_rogue", at(9, 6));
    hero(state, "di", "devops_mage", at(7, 9));
    unit(state, "ann").abilities = ["clarion_call"];
    for (const id of ["ann", "bo", "cy", "di"]) unit(state, id).hp = 1;
    const events: ZoneEvent[] = [];
    const next = must(state, { type: "use", by: "ann", unit: "ann", ability: "clarion_call", target: "bo" }, events);
    const healed = events.flatMap((e) => (e.t === "heal" ? [e.target] : [])).sort();
    expect(healed).toEqual(["bo", "cy"]);
    expect(unit(next, "bo").hp).toBeGreaterThan(unit(state, "bo").hp);
    expect(unit(next, "di").hp).toBe(1);
    expect(unit(next, "ann").hp).toBe(1);
  });
});

describe("Sage weapons", () => {
  it("gives the orb and scepter two abilities each, with St. Elmo's Fire and Rust Armor on a longer cooldown", () => {
    expect(WEAPONS.orb.abilities).toEqual(["starbeam", "st_elmos_fire"]);
    expect(WEAPONS.scepter.abilities).toEqual(["water_burst", "rust_armor"]);
    for (const id of ["starbeam", "water_burst"]) expect(tacticOf(id).cooldown, id).toBe(Object.values(WEAPONS).some((w) => w.abilities[0] === id) ? undefined : 1);
    expect(tacticOf("st_elmos_fire").cooldown).toBe(3);
    expect(tacticOf("rust_armor").cooldown).toBe(2);
    expect(tacticOf("st_elmos_fire").cost).toBe(BONUS_AP);
    expect(abilityDiceFor(ABILITIES.starbeam)).toEqual({ n: 1, d: 6, plus: 3 });
    expect(ABILITIES.rust_armor.perfect).toEqual({ effect: "sundered", turns: 3 });
  });

  it("Starbeam: a hit lights the target with Guiding Light only if it fails its save", () => {
    const { state, foe } = duel("dummy", "staff_sage", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["starbeam"];
    const lit = (s: ZoneState) => unit(s, foe).conditions.some((c) => c.kind === "guiding_light");
    const failed = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "starbeam", target: foe }, foe, failedSave);
    expect(lit(failed.state)).toBe(true);
    const saved = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "starbeam", target: foe }, foe, savedAll);
    expect(lit(saved.state)).toBe(false);
    expect(unit(failed.state, foe).conditions.some((c) => c.kind === "exposed")).toBe(false);
  });

  it("St. Elmo's Fire: a Bonus action that gives an ally within 4 hexes North Star, none of it a blow", () => {
    let { state } = duel("dummy", "staff_sage", at(5, 6), at(11, 6));
    hero(state, "bo", "qa_paladin", at(9, 6));
    hero(state, "cy", "refactor_rogue", at(12, 9));
    unit(state, "ann").abilities = ["st_elmos_fire"];
    expect(hexDistance(unit(state, "ann").pos, unit(state, "bo").pos)).toBe(3);
    expect(checkAbility(state, unit(state, "ann"), "st_elmos_fire", { target: "cy" })).toMatch(/Out of range/);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "st_elmos_fire", target: "bo" });
    expect(unit(state, "bo").conditions.some((c) => c.kind === "north_star")).toBe(true);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" });
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "st_elmos_fire", target: "bo" })).toMatch(/not ready/);
  });

  it("Water Burst: a hit drenches every other enemy beside the target, and none further off", () => {
    const { state, foe } = duel("dummy", "devops_mage", at(5, 6), at(9, 6));
    const next = enemy(state, "dummy", at(10, 6));
    const far = enemy(state, "dummy", at(9, 9));
    expect(adjacent(unit(state, foe).pos, next.pos)).toBe(true);
    expect(adjacent(unit(state, foe).pos, far.pos)).toBe(false);
    unit(state, "ann").abilities = ["water_burst"];
    const after = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "water_burst", target: foe }, foe);
    expect(unit(after.state, next.id).hp).toBeLessThan(unit(state, next.id).hp);
    expect(unit(after.state, far.id).hp).toBe(unit(state, far.id).hp);
    expect(after.events.filter((e) => e.t === "hit" && e.what === "water_burst")).toHaveLength(2);
  });

  it("Rust Armor: 3 hexes, strikes only enemies, and Sunders those that fail to brace", () => {
    const { state, foe } = duel("dummy", "staff_sage", at(5, 6), at(9, 6));
    hero(state, "bo", "qa_paladin", at(10, 6));
    unit(state, "ann").abilities = ["rust_armor"];
    expect(abilityArea(state, unit(state, "ann"), "rust_armor", unit(state, foe).pos)).toHaveLength(3);
    const bo = unit(state, "bo").hp;
    const after = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "rust_armor", at: unit(state, foe).pos }, foe, failedSave);
    expect(unit(after.state, foe).conditions.find((c) => c.kind === "sundered")?.rounds).toBeGreaterThan(0);
    expect(unit(after.state, "bo").hp).toBe(bo);
    const dc = defenceOf(unit(after.state, foe), after.state);
    expect(dc).toBe(defenceOf(unit(state, foe), state) - 2);
  });

  it("gives the astrolabe Moonlight and Focus Light, Focus Light once a turn", () => {
    expect(WEAPONS.astrolabe.abilities).toEqual(["moonlight", "focus_light"]);
    expect(tacticOf("moonlight").cooldown).toBeUndefined();
    expect(tacticOf("focus_light").cooldown).toBe(1);
    expect(tacticOf("focus_light").cost).toBe(BONUS_AP);
    expect(tacticOf("moonlight").range).toBe(7);
    expect(tacticOf("focus_light").range).toBe(5);
  });

  it("Moonlight: 3 hexes, strikes only enemies, and lights those that fail to brace", () => {
    const { state, foe } = duel("dummy", "staff_sage", at(5, 6), at(9, 6));
    hero(state, "bo", "qa_paladin", at(10, 6));
    unit(state, "ann").abilities = ["moonlight"];
    expect(abilityArea(state, unit(state, "ann"), "moonlight", unit(state, foe).pos)).toHaveLength(3);
    const bo = unit(state, "bo").hp;
    const lit = (s: ZoneState) => unit(s, foe).conditions.some((c) => c.kind === "guiding_light");
    const failed = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "moonlight", at: unit(state, foe).pos }, foe, failedSave);
    expect(lit(failed.state)).toBe(true);
    expect(unit(failed.state, "bo").hp).toBe(bo);
    const saved = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "moonlight", at: unit(state, foe).pos }, foe, savedAll);
    expect(lit(saved.state)).toBe(false);
  });

  it("Focus Light: a Bonus action that sets a target Burning only if it is lit by Guiding Light", () => {
    const { state, foe } = duel("dummy", "staff_sage", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["focus_light"];
    const burning = (s: ZoneState) => unit(s, foe).conditions.some((c) => c.kind === "burning");
    const plain = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "focus_light", target: foe }, foe);
    expect(burning(plain.state)).toBe(false);
    expect(plain.state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    const ctx: Ctx = { state, rng: makeRng(1), events: [], effects: [] };
    addCondition(ctx, unit(state, foe), "guiding_light", 3);
    const lit = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "focus_light", target: foe }, foe);
    expect(burning(lit.state)).toBe(true);
  });
});

describe("Warden weapons", () => {
  it("starts the Warden with the maul, and gives each weapon two abilities, the second once a turn, Guard and Throw Pike longer", () => {
    expect(HERO_CLASSES.find((c) => c.id === "sre_warden")!.weapons[0]).toBe("maul");
    expect(WEAPONS.maul.abilities).toEqual(["sturdy_blow", "stand_strong"]);
    expect(WEAPONS.pager_axe.abilities).toEqual(["disarming_chop", "raise_guard"]);
    expect(WEAPONS.boarding_pike.abilities).toEqual(["goading_strike", "throw_pike"]);
    for (const id of ["sturdy_blow", "stand_strong", "disarming_chop", "goading_strike"]) expect(tacticOf(id).cooldown, id).toBe(Object.values(WEAPONS).some((w) => w.abilities[0] === id) ? undefined : 1);
    expect(tacticOf("raise_guard").cooldown).toBe(2);
    expect(tacticOf("throw_pike").cooldown).toBe(3);
    for (const id of ["stand_strong", "raise_guard"]) expect(tacticOf(id).cost, id).toBe(BONUS_AP);
    expect(ABILITIES.disarming_chop.perfect).toEqual({ effect: "glitched", turns: 1 });
  });

  it("Sturdy Blow: a shield, hit or miss, on top of any already there", () => {
    const { state, foe } = duel("dummy", "sre_warden", at(5, 6), at(7, 6));
    unit(state, "ann").abilities = ["sturdy_blow"];
    const shield = STURDY.shield + unit(state, "ann").level;
    let missed = false;
    for (let seed = 1; seed < 60 && !missed; seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "sturdy_blow", target: foe }, events);
      expect(shieldOf(unit(next, "ann"))).toBe(shield);
      missed = events.some((e) => e.t === "miss");
    }
    expect(missed).toBe(true);
  });

  it("Stand Strong: a Bonus action shield, bigger for each enemy beside the Warden", () => {
    let { state } = duel("dummy", "sre_warden", at(5, 6), at(7, 6));
    enemy(state, "dummy", at(6, 7));
    enemy(state, "dummy", at(10, 9));
    unit(state, "ann").abilities = ["stand_strong"];
    const beside = state.units.filter((u) => u.side === "enemy" && adjacent(u.pos, unit(state, "ann").pos)).length;
    expect(beside).toBe(2);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "stand_strong" });
    expect(shieldOf(unit(state, "ann"))).toBe(STAND_STRONG.shield + unit(state, "ann").level + STAND_STRONG.perFoe * beside);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
  });

  it("Disarming Chop: a hit leaves the target Fumbling unless it saves", () => {
    const { state, foe } = duel("dummy", "sre_warden", at(5, 6), at(7, 6));
    unit(state, "ann").abilities = ["disarming_chop"];
    const fumbling = (s: ZoneState) => unit(s, foe).conditions.some((c) => c.kind === "glitched");
    expect(fumbling(untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "disarming_chop", target: foe }, foe, failedSave).state)).toBe(true);
    expect(fumbling(untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "disarming_chop", target: foe }, foe, savedAll).state)).toBe(false);
  });

  it("Against the Waves (the axe): a Bonus action that shields the Warden, more in water, then waits a turn", () => {
    let { state } = duel("dummy", "sre_warden", at(5, 6), at(9, 6));
    expect(ABILITIES.raise_guard.name).toBe("Against the Waves");
    unit(state, "ann").abilities = ["raise_guard"];
    const wet = paint(structuredClone(state), "water", [unit(state, "ann").pos]);
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "raise_guard" });
    expect(unit(state, "ann").conditions.some((c) => c.kind === "guarded")).toBe(false);
    expect(shieldOf(unit(state, "ann"))).toBe(AGAINST_WAVES.shield + unit(state, "ann").level);
    const soaked = must(wet, { type: "use", by: "ann", unit: "ann", ability: "raise_guard" });
    expect(shieldOf(unit(soaked, "ann"))).toBe(AGAINST_WAVES.shield + unit(soaked, "ann").level + AGAINST_WAVES.water);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" });
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "raise_guard" })).toMatch(/not ready/);
  });

  it("Goading Strike: a hit leaves the target Taunted by the Warden unless it saves", () => {
    const { state, foe } = duel("dummy", "sre_warden", at(5, 6), at(7, 6));
    unit(state, "ann").abilities = ["goading_strike"];
    const taunted = (s: ZoneState) => unit(s, foe).conditions.find((c) => c.kind === "taunted");
    const failed = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "goading_strike", target: foe }, foe, failedSave);
    expect(taunted(failed.state)).toMatchObject({ rounds: 2, by: "ann" });
    expect(taunted(untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "goading_strike", target: foe }, foe, savedAll).state)).toBeUndefined();
  });

  it("Throw Pike: reaches 3 hexes and drags what it hits straight in to beside the Warden", () => {
    const { state, foe } = duel("dummy", "sre_warden", at(4, 6), at(8, 6));
    unit(state, "ann").abilities = ["throw_pike"];
    expect(hexDistance(unit(state, "ann").pos, unit(state, foe).pos)).toBe(3);
    const after = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "throw_pike", target: foe }, foe);
    expect(unit(after.state, foe).pos).toEqual(at(6, 6));
    unit(state, foe).pos = at(9, 6);
    expect(checkAbility(state, unit(state, "ann"), "throw_pike", { target: foe })).toMatch(/Out of range/);
  });
});

describe("Warlock weapons", () => {
  const drowning = (s: ZoneState, id: string) => unit(s, id).conditions.find((c) => c.kind === "drowning")?.amount ?? 0;

  it("keeps Hex and Soul Drain on the grimoire, Hex with no share of max HP and Soul Drain on a 2-turn wait", () => {
    expect(WEAPONS.grimoire.abilities).toEqual(["hex", "soul_drain"]);
    expect(WEAPONS.void_staff.abilities).toEqual(["sink", "pull_of_the_deep"]);
    expect(abilityDiceFor(ABILITIES.hex)).toEqual({ n: 1, d: 6, plus: 2 });
    expect(ABILITIES.soul_drain.damage).toBe(11);
    expect(tacticOf("soul_drain").cooldown).toBe(3);
    expect(tacticOf("hex").cooldown).toBeUndefined();
    expect(tacticOf("sink").cooldown).toBeUndefined();
    expect(tacticOf("pull_of_the_deep").cooldown).toBe(3);
  });

  it("Sink: a hit leaves a stack of Drowning unless the target saves", () => {
    const { state, foe } = duel("dummy", "data_warlock", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["sink"];
    let sunk = false;
    let held = false;
    for (let seed = 1; seed < 120 && !(sunk && held); seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "sink", target: foe }, events);
      if (!events.some((e) => e.t === "hit" && e.target === foe)) continue;
      const save = events.find((e) => e.t === "roll" && e.roll.kind === "save");
      const failed = save?.t === "roll" && !save.roll.ok;
      expect(drowning(next, foe)).toBe(failed ? 1 : 0);
      if (failed) sunk = true;
      else held = true;
    }
    expect(sunk && held).toBe(true);
  });

  it("Pull of the Deep: 3 hexes up to 5 off; strikes every enemy in them, not an ally or one outside, and drowns those that fail to brace", () => {
    const { state, foe } = duel("dummy", "data_warlock", at(5, 6), at(9, 6));
    const far = enemy(state, "dummy", at(9, 11));
    hero(state, "bo", "qa_paladin", at(9, 7));
    unit(state, "ann").abilities = ["pull_of_the_deep"];
    const at9 = unit(state, foe).pos;
    expect(abilityArea(state, unit(state, "ann"), "pull_of_the_deep", at9)).toHaveLength(3);
    const bo = unit(state, "bo").hp;
    let drowned = false;
    for (let seed = 1; seed < 120 && !drowned; seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "pull_of_the_deep", at: at9 }, events);
      expect(events.some((e) => e.t === "hit" && e.target === foe)).toBe(true);
      expect(unit(next, far.id).hp).toBe(unit(state, far.id).hp);
      expect(unit(next, "bo").hp).toBe(bo);
      expect(drowning(next, "bo")).toBe(0);
      drowned = drowning(next, foe) === 1;
    }
    expect(drowned).toBe(true);
    // Too far off to aim at.
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "pull_of_the_deep", at: at(13, 6) })).toMatch(/range/i);
  });

  it("Soul Drain: heals the Warlock half the damage it deals", () => {
    const { state, foe } = duel("dummy", "data_warlock", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["soul_drain"];
    unit(state, "ann").hp = 1;
    const after = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "soul_drain", target: foe }, foe);
    const blow = after.events.find((e) => e.t === "hit" && e.target === foe);
    const healed = after.events.find((e) => e.t === "heal" && e.target === "ann");
    if (blow?.t !== "hit" || healed?.t !== "heal") throw new Error("no drain");
    expect(ABILITIES.soul_drain.drain).toBe(0.5);
    expect(healed.amount).toBe(Math.min(unit(state, "ann").maxHp - 1, Math.max(1, Math.round(blow.amount * 0.5))));
  });

  it("gives the chalice Vile Splash and Drink Deeply, Drink Deeply on a cooldown", () => {
    expect(WEAPONS.bilge_chalice.abilities).toEqual(["vile_splash", "drink_deeply"]);
    expect(tacticOf("vile_splash").cooldown).toBeUndefined();
    expect(tacticOf("drink_deeply").cooldown).toBe(3);
    expect(tacticOf("drink_deeply").cost).toBe(BONUS_AP);
  });

  it("Vile Splash: a hit leaves poison under the target, which Poisons it", () => {
    const { state, foe } = duel("dummy", "data_warlock", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["vile_splash"];
    for (let seed = 1; seed < 80; seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "vile_splash", target: foe }, events);
      const hit = events.some((e) => e.t === "hit" && e.target === foe);
      expect(next.surfaces[posKey(unit(next, foe).pos)]?.kind === "poison").toBe(hit);
      if (!hit) continue;
      expect(unit(next, foe).conditions.some((c) => c.kind === "poisoned")).toBe(true);
      return;
    }
    throw new Error("never landed");
  });

  it("Drink Deeply: a Bonus action that heals the Warlock a lot and Poisons them, then waits", () => {
    let { state, foe } = duel("dummy", "data_warlock", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["drink_deeply"];
    unit(state, "ann").hp = 1;
    state = must(state, { type: "use", by: "ann", unit: "ann", ability: "drink_deeply" });
    expect(unit(state, "ann").hp).toBeGreaterThan(10);
    expect(unit(state, "ann").conditions.some((c) => c.kind === "poisoned")).toBe(true);
    expect(attackContext(state, unit(state, "ann"), unit(state, foe), { melee: false }).adv).toBe(-1);
    expect(state.encounter!.budgets.ann).toMatchObject({ ap: AP_TURN - BONUS_AP });
    state = must(state, { type: "end_turn", by: "ann", unit: "ann" });
    while (!state.encounter!.acting.includes("ann") || state.encounter!.done.includes("ann")) state = must(state, { type: "timeout" });
    expect(unit(state, "ann").conditions.some((c) => c.kind === "poisoned")).toBe(true);
    expect(fails(state, { type: "use", by: "ann", unit: "ann", ability: "drink_deeply" })).toMatch(/not ready/);
  });

  it("Riptide: a Warlock's critical hit adds a stack of Drowning, not Bleeding", () => {
    const { state, foe } = duel("dummy", "data_warlock", at(5, 6), at(9, 6));
    unit(state, "ann").abilities = ["vile_splash"];
    for (let seed = 1; seed < 400; seed++) {
      const tryState = structuredClone(state);
      tryState.rng = seed;
      const events: ZoneEvent[] = [];
      const next = must(tryState, { type: "use", by: "ann", unit: "ann", ability: "vile_splash", target: foe }, events);
      const hit = events.find((e) => e.t === "hit" && e.target === foe);
      if (!hit || hit.t !== "hit") continue;
      expect(drowning(next, foe)).toBe(hit.crit ? 1 : 0);
      expect(unit(next, foe).conditions.some((c) => c.kind === "bleeding")).toBe(false);
      if (hit.crit) return;
    }
    throw new Error("never a critical hit");
  });
});

describe("Ship's guns", () => {
  /** A Paladin on one hex and a dummy `gap` hexes off along the row. */
  const gap = (n: number) => {
    const d = duel("dummy", "qa_paladin", at(4, 6), at(4 + n, 6));
    unit(d.state, "ann").pos = at(4, 6);
    unit(d.state, d.foe).pos = at(4 + n, 6);
    return d;
  };
  it("are weapons no class owns, with two abilities each, that a Paladin can carry into a fight", () => {
    expect(WEAPONS.pistol.abilities).toEqual(["pistol_shot", "pistol_whip"]);
    expect(WEAPONS.blunderbuss.abilities).toEqual(["butt_stroke", "scattershot"]);
    expect(WEAPONS.harpoon_gun.abilities).toEqual(["barbed_line", "harpoon_shot"]);
    // The first of each is the plain attack, with no wait.
    for (const id of ["butt_stroke", "barbed_line"]) expect(TACTICS[id].cooldown, id).toBeUndefined();
    expect(ABILITIES.butt_stroke.name).toBe("Bludgeon");
    for (const id of ["pistol", "blunderbuss", "harpoon_gun"]) expect(WEAPONS[id].classId, id).toBeUndefined();
    const { state } = duel("dummy", "qa_paladin", at(4, 6), at(8, 6));
    unit(state, "ann").abilities = abilitiesFor("pistol");
    expect(unit(state, "ann").abilities).toContain("pistol_shot");
  });

  it("reach as they say: the pistol 6 hexes, the harpoon 6, the barbed line 3, the whip and butt only beside you", () => {
    expect(TACTICS.pistol_shot).toMatchObject({ reach: "ranged", range: 6 });
    expect(TACTICS.harpoon_shot).toMatchObject({ reach: "ranged", range: 6, pull: 2, cooldown: 3 });
    expect(TACTICS.barbed_line).toMatchObject({ reach: "ranged", range: 3 });
    expect(TACTICS.pistol_whip).toMatchObject({ reach: "melee", cost: BONUS_AP });
    expect(TACTICS.butt_stroke).toMatchObject({ reach: "melee" });
    const { state, foe } = gap(6);
    unit(state, "ann").abilities = ["pistol_shot"];
    expect(hexDistance(unit(state, "ann").pos, unit(state, foe).pos)).toBe(6);
    expect(checkAbility(state, unit(state, "ann"), "pistol_shot", { target: foe })).toBeNull();
    unit(state, foe).pos = at(11, 6);
    expect(hexDistance(unit(state, "ann").pos, unit(state, foe).pos)).toBe(7);
    expect(checkAbility(state, unit(state, "ann"), "pistol_shot", { target: foe })).toMatch(/Out of range/);
  });

  it("Harpoon: reaches 6 hexes and hauls what it hits 2 hexes toward the shooter", () => {
    const { state, foe } = gap(6);
    unit(state, "ann").abilities = ["harpoon_shot"];
    const after = untilHit(state, { type: "use", by: "ann", unit: "ann", ability: "harpoon_shot", target: foe }, foe);
    expect(unit(after.state, foe).pos).toEqual(at(8, 6));
    // The haul is told as pulled, a step at a time, not as a shove back.
    expect(after.events.filter((e) => e.t === "shoved").map((e) => (e.t === "shoved" ? e.pulled : 0))).toEqual([1, 2]);
    unit(state, foe).pos = at(11, 6);
    expect(checkAbility(state, unit(state, "ann"), "harpoon_shot", { target: foe })).toMatch(/Out of range/);
  });

  it("Scattershot: a cone 3 hexes long that strikes the enemies in it and leaves an ally in the cone alone", () => {
    let { state, foe } = duel("dummy", "qa_paladin", at(5, 6), at(7, 6));
    hero(state, "bo", "qa_paladin", at(6, 6));
    state.encounter!.acting = ["ann"];
    unit(state, "ann").abilities = ["scattershot"];
    const bo = unit(state, "bo").hp;
    const cone = abilityArea(state, unit(state, "ann"), "scattershot", unit(state, foe).pos);
    expect(cone.map(posKey)).toContain(posKey(unit(state, foe).pos));
    expect(Math.max(...cone.map((p) => hexDistance(p, unit(state, "ann").pos)))).toBe(3);
    const events: ZoneEvent[] = [];
    const next = must(state, { type: "use", by: "ann", unit: "ann", ability: "scattershot", at: unit(state, foe).pos }, events);
    expect(unit(next, "bo").hp).toBe(bo);
    expect(events.some((e) => e.t === "hit" && e.target === foe)).toBe(true);
  });
});
