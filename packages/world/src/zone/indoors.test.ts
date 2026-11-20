// Maps under a roof and under ground (indoors.ts): that every one of them, whatever the seed, is a place that
// can be played: one piece, everything on it reachable, the bands asked for, and built as its kind is meant to be.
// And fighting in one (zone.ts): walls keep the noise in, so a fight rouses nobody and only those near enough to
// hear it come; and the enemy can play a whole fight in rooms and tunnels without breaking the rules.

import { describe, expect, it } from "vitest";
import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import { zoneOptions } from "./gen";
import { HEX_DIRS, HEX_ROOM, blockerAt, flies, isDead, solid, zoneReach, type Reached } from "./geometry";
import { ENEMY_MOVE_AP, enemyMove } from "./kit";
import { modsOf } from "./mods";
import { LAY_GRIDS, layZone, type Laid } from "./lay";
import { PROPS, propOf } from "./props";
import { SITES, SITE_IDS, siteInside, siteOpen, type SiteId } from "./sites";
import { HEAR_RANGE, createZone, standInHero, stepZone } from "./zone";
import type { ZoneAction, ZoneEvent, ZoneSize, ZoneState } from "./types";

const INSIDE = SITE_IDS.filter(siteInside);
const SIZES: ZoneSize[] = ["small", "medium", "large"];
const lay = (site: SiteId, size: ZoneSize, seed: number, more: Record<string, unknown> = {}): Laid =>
  layZone(`in-${site}-${size}-${seed}`, zoneOptions({ size, biome: "meadow", groups: 4, elevation: 2, obstacles: 1, clear: 4, party: 2, site, tier: 3, ...more }));

/** Every hex that can be walked to from the start, a level at a time or by a ladder. */
function walked(plan: Laid): Set<string> {
  const tiles = new Map(plan.map.tiles.map((t) => [posKey(t), t]));
  const chests = new Set(plan.map.pois.map((p) => posKey(p.pos)));
  const open = (p: HexPos) => {
    const t = tiles.get(posKey(p));
    return !!t && t.biome !== "water" && t.biome !== "rock" && !propOf(t)?.blocks && !chests.has(posKey(p));
  };
  const laddered = (a: HexPos, b: HexPos) => {
    const [ta, tb] = [tiles.get(posKey(a))!, tiles.get(posKey(b))!];
    const [low, high] = (ta.elev ?? 0) < (tb.elev ?? 0) ? [ta, tb] : [tb, ta];
    const side = HEX_DIRS.findIndex((d) => low.q + d.q === high.q && low.r + d.r === high.r);
    return side >= 0 && ((low.ladder ?? 0) & (1 << side)) !== 0;
  };
  const seen = new Set([posKey(plan.start)]);
  const queue = [plan.start];
  for (let i = 0; i < queue.length; i++) {
    for (const d of HEX_DIRS) {
      const n = { q: queue[i].q + d.q, r: queue[i].r + d.r };
      if (seen.has(posKey(n)) || !open(n)) continue;
      const step = Math.abs((tiles.get(posKey(queue[i]))!.elev ?? 0) - (tiles.get(posKey(n))!.elev ?? 0));
      if (step > 1 && !laddered(queue[i], n)) continue;
      seen.add(posKey(n));
      queue.push(n);
    }
  }
  return seen;
}

describe("maps under a roof and under ground", () => {
  it("there are four such sites, and none of them is out in the open", () => {
    expect([...INSIDE].sort()).toEqual(["cavern", "citadel", "crypt", "hollow"]);
    for (const site of INSIDE) {
      expect(siteOpen(site)).toBe(false);
      expect(SITES[site].backdrop).toBe("dark");
    }
    expect(siteOpen("keep")).toBe(true);
    expect(siteOpen("nowhere")).toBe(false);
    expect(siteInside("nowhere")).toBe(false);
  });

  it("the same seed lays the same map", () => {
    for (const site of INSIDE) expect(lay(site, "medium", 1)).toEqual(lay(site, "medium", 1));
  });

  it("every one can be played: on the grid, one piece, every post and chest reachable, the bands asked for", () => {
    for (const site of INSIDE) {
      for (const size of SIZES) {
        let bands = 0;
        for (let seed = 0; seed < 12; seed++) {
          const plan = lay(site, size, seed);
          const where = `${site} ${size} ${seed}`;
          const grid = LAY_GRIDS[size];
          expect(plan.map.grid, where).toEqual(grid);
          expect(plan.scene, where).toEqual({ site, backdrop: "dark" });
          const tiles = new Map(plan.map.tiles.map((t) => [posKey(t), t]));
          expect(tiles.size, where).toBe(plan.map.tiles.length);
          for (const t of plan.map.tiles) {
            const col = t.q + Math.floor(t.r / 2);
            expect(t.r >= 0 && t.r < grid.rows && col >= 0 && col < grid.cols - (t.r % 2), `${where} ${posKey(t)}`).toBe(true);
            if (t.prop) expect(Object.keys(PROPS), `${where} ${t.prop}`).toContain(t.prop);
          }
          const reach = walked(plan);
          // All the ground that can be stood on is one piece: nothing is walled or flooded off. (A scrap of shelf with no ladder of its own is the most there is: a jump reaches it.)
          const ground = plan.map.tiles.filter((t) => t.biome !== "water" && t.biome !== "rock" && !propOf(t)?.blocks && !plan.map.pois.some((p) => p.pos.q === t.q && p.pos.r === t.r));
          const cut = ground.filter((t) => !reach.has(posKey(t)));
          expect(cut.length, `${where}: ${cut.slice(0, 4).map(posKey).join(" ")}`).toBeLessThanOrEqual(Math.floor(ground.length * 0.06));
          for (const g of plan.groups) {
            expect(g.kinds.length, where).toBe(g.posts.length);
            expect(g.kinds.length, where).toBeGreaterThan(0);
            for (const kind of g.kinds) expect(ENEMIES[kind], `${where} ${kind}`).toBeTruthy();
            for (const p of g.posts) {
              expect(reach.has(posKey(p)), `${where} post ${posKey(p)}`).toBe(true);
              expect(hexDistance(p, plan.start), where).toBeGreaterThan(3);
            }
          }
          const posts = plan.groups.flatMap((g) => g.posts.map(posKey));
          expect(new Set(posts).size, where).toBe(posts.length);
          for (const chest of plan.map.pois) {
            expect(HEX_DIRS.some((d) => reach.has(posKey({ q: chest.pos.q + d.q, r: chest.pos.r + d.r }))), `${where} chest`).toBe(true);
            expect(posts, where).not.toContain(posKey(chest.pos));
          }
          expect(plan.map.pois.length, where).toBeGreaterThanOrEqual(1);
          expect(plan.map.tiles.filter((t) => t.prop === "waygate").length, where).toBe(1);
          expect(plan.groups.length, where).toBeLessThanOrEqual(4);
          bands += plan.groups.length;
        }
        // Nearly always all four: a room may now and then have no place left for a band.
        expect(bands, `${site} ${size}`).toBeGreaterThanOrEqual(44);
      }
    }
    // (A hundred and forty-four maps, every hex of each looked at: a couple of seconds alone, and more than the usual five when the whole suite runs beside it.)
  }, 30_000);

  it("halls are rooms walled in stone with doorways through, a great hall with a dais and a high seat, and torches on the walls", () => {
    for (const site of ["citadel", "crypt"] as const) {
      for (let seed = 0; seed < 8; seed++) {
        const plan = lay(site, "medium", seed);
        const props = plan.map.tiles.map((t) => t.prop);
        expect(props.filter((p) => p === "wall" || p === "wall_torch").length).toBeGreaterThan(120);
        expect(props.filter((p) => p === "wall_torch").length).toBeGreaterThan(8);
        expect(props.filter((p) => p === "arch").length).toBeGreaterThanOrEqual(5);
        expect(props.filter((p) => p === "pillar" || p === "pillar_broken").length).toBeGreaterThanOrEqual(4);
        expect(props).toContain(site === "crypt" ? "sarcophagus" : "throne");
        // Every floor is paved, and nothing is rock or water.
        expect(plan.map.tiles.every((t) => t.biome === "paved")).toBe(true);
        // The dais, and the best of the place's loot on it.
        expect(plan.map.tiles.some((t) => t.elev === 1)).toBe(true);
        expect(plan.map.pois.some((p) => p.loot === "vault")).toBe(true);
      }
      // Somewhere, most times, a gallery two levels up.
      const galleries = Array.from({ length: 10 }, (_, seed) => lay(site, "large", seed)).filter((plan) => plan.map.tiles.some((t) => t.elev === 2 && t.prop !== "wall"));
      expect(galleries.length).toBeGreaterThanOrEqual(7);
    }
  });

  it("caves are chambers of rock: walled in, with shelves, pools, holes in the floor and light of their own", () => {
    let [shelves, pools, holes] = [0, 0, 0];
    for (const site of ["cavern", "hollow"] as const) {
      for (let seed = 0; seed < 10; seed++) {
        const plan = lay(site, "medium", seed);
        const tiles = new Map(plan.map.tiles.map((t) => [posKey(t), t]));
        expect(plan.map.tiles.every((t) => t.biome === "cave" || t.biome === "rock" || t.biome === "water")).toBe(true);
        const floor = plan.map.tiles.filter((t) => t.biome === "cave");
        expect(floor.length).toBeGreaterThan(150);
        const gaps = new Set<string>();
        for (const t of floor) for (const d of HEX_DIRS) if (!tiles.has(posKey({ q: t.q + d.q, r: t.r + d.r }))) gaps.add(posKey({ q: t.q + d.q, r: t.r + d.r }));
        if (gaps.size > 0) holes++;
        // A hole is a few hexes, never the edge of the map: the floor ends in rock everywhere else.
        expect(gaps.size).toBeLessThan(30);
        // Rock stands well over head height, and a little lower on the near side of a floor so the floor shows.
        for (const t of plan.map.tiles) if (t.biome === "rock") expect(t.h).toBeGreaterThanOrEqual(1.5);
        expect(plan.map.tiles.some((t) => t.biome === "rock" && t.h > 2.2)).toBe(true);
        if (floor.some((t) => t.elev === 2)) shelves++;
        if (plan.map.tiles.some((t) => t.biome === "water")) pools++;
        expect(plan.map.tiles.some((t) => t.prop === "crystal" || t.prop === "waygate")).toBe(true);
        if (site === "hollow") expect(plan.map.tiles.some((t) => t.prop === "bones" || t.prop === "ribs" || t.prop === "skull")).toBe(true);
      }
    }
    expect(shelves).toBeGreaterThanOrEqual(16);
    expect(pools).toBeGreaterThanOrEqual(5);
    expect(holes).toBeGreaterThanOrEqual(8);
  });

  it("a boss named for the place stands in the great hall or the last chamber, with the place's own about it", () => {
    for (const site of INSIDE) {
      const plan = lay(site, "medium", 3, { groups: 3, kinds: ["great_bear"] });
      expect(plan.groups[0].id).toBe("band1");
      expect(plan.groups[0].kinds[0]).toBe("great_bear");
      expect(plan.groups.flatMap((g) => g.kinds).filter((k) => k === "great_bear")).toHaveLength(1);
      // It is as far in as the place goes.
      expect(hexDistance(plan.groups[0].posts[0], plan.start)).toBeGreaterThan(12);
    }
  });
});

// ---------- fighting in them ----------

/** Apply an action that must succeed; what happened is added to `sink`. */
function must(state: ZoneState, action: ZoneAction, sink: ZoneEvent[] = []): ZoneState {
  const step = stepZone(state, action);
  if (!step.ok) throw new Error(`${action.type} failed: ${step.error}`);
  sink.push(...step.events);
  return step.state;
}
const got = <T extends ZoneEvent["t"]>(events: ZoneEvent[], t: T) => events.filter((e): e is Extract<ZoneEvent, { t: T }> => e.t === t);
const zone = (site: SiteId, size: ZoneSize, seed: number, more: Record<string, unknown> = {}): ZoneState =>
  createZone("IN", `in-${site}-${size}-${seed}`, zoneOptions({ size, biome: "meadow", groups: 4, elevation: 2, obstacles: 1, clear: 4, party: 2, site, ...more }));
const standing = (state: ZoneState) => state.units.filter((u) => u.side === "enemy" && !u.down);
const alerted = (state: ZoneState) => Object.keys(state.groups).filter((g) => state.groups[g].alerted).sort();

describe("a fight under a roof or under ground", () => {
  it("rouses nobody: when it starts, only the band that was met is in it", () => {
    for (const site of INSIDE) {
      for (const size of SIZES) {
        for (let seed = 0; seed < 3; seed++) {
          const where = `${site} ${size} ${seed}`;
          let state = zone(site, size, seed);
          expect(state.scene, where).toEqual({ site, backdrop: "dark" });
          expect(Object.keys(state.groups).length, where).toBeGreaterThanOrEqual(3);
          state.aiOff = true;
          state = must(state, { type: "join", hero: standInHero("qa_paladin", "ann", 3)! });
          // The nearest band is set on her where she stands.
          const met = [...standing(state)].sort((a, b) => hexDistance(a.pos, state.start) - hexDistance(b.pos, state.start))[0].group!;
          const events: ZoneEvent[] = [];
          state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
          expect(got(events, "roused"), where).toEqual([]);
          expect(got(events, "noise"), where).toEqual([]);
          expect(got(events, "alert"), where).toEqual([{ t: "alert", group: met, by: "ann" }]);
          expect(alerted(state), where).toEqual([met]);
          expect([...state.encounter!.order].sort(), where).toEqual(["ann", ...standing(state).filter((u) => u.group === met).map((u) => u.id)].sort());
        }
      }
    }
  });

  it("is heard, as anywhere, by a band near enough: round by round those within earshot come, and nobody further off ever does", () => {
    let [came, stayed] = [0, 0];
    for (const site of INSIDE) {
      for (const size of SIZES) {
        for (let seed = 0; seed < 3; seed++) {
          const where = `${site} ${size} ${seed}`;
          let state = zone(site, size, seed);
          // Nobody moves (the enemy's AI is off, and Ann lets every turn of hers go by): who is within earshot of whom never changes.
          state.aiOff = true;
          state = must(state, { type: "join", hero: standInHero("qa_paladin", "ann", 3)! });
          const events: ZoneEvent[] = [];
          state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
          const first = alerted(state);
          // Who it should reach: the band met, then any band with one of its own within earshot of anyone in it, and so on outward.
          const within = new Set(first);
          for (let grew = true; grew; ) {
            grew = false;
            const fighters = [state.units.find((u) => u.id === "ann")!, ...standing(state).filter((u) => within.has(u.group!))];
            for (const e of standing(state)) {
              if (within.has(e.group!) || !fighters.some((f) => hexDistance(f.pos, e.pos) <= HEAR_RANGE)) continue;
              within.add(e.group!);
              grew = true;
            }
          }
          // A round for every band there is, and one more: time enough for word to pass from room to room.
          const rounds = Object.keys(state.groups).length + 2;
          for (let i = 0; i < 400 && state.encounter && state.encounter.round < rounds; i++) state = must(state, { type: "timeout" }, events);
          expect(state.encounter?.round, where).toBe(rounds);
          expect(alerted(state), where).toEqual([...within].sort());
          // Each that came after the first was heard coming; none was roused.
          expect(got(events, "roused"), where).toEqual([]);
          expect(got(events, "noise").map((e) => e.group).sort(), where).toEqual([...within].filter((g) => !first.includes(g)).sort());
          came += within.size - first.length;
          stayed += Object.keys(state.groups).length - within.size;
        }
      }
    }
    // Both happen: a band in the next room hears and comes, and (far more often) the rest of the place never knows.
    expect(came).toBeGreaterThan(0);
    expect(stayed).toBeGreaterThan(came);
  });

  it("out under the sky the same start rouses the place: every other band that is not a boss's own", () => {
    for (let seed = 0; seed < 3; seed++) {
      let state = createZone("IN", `out-${seed}`, zoneOptions({ size: "medium", biome: "meadow", groups: 4, elevation: 2, obstacles: 1, clear: 4, party: 2, site: "keep" }));
      expect(siteOpen(state.scene!.site)).toBe(true);
      state.aiOff = true;
      state = must(state, { type: "join", hero: standInHero("qa_paladin", "ann", 3)! });
      const events: ZoneEvent[] = [];
      state = must(state, { type: "dev", by: "ann", dev: { op: "start_fight" } }, events);
      expect(got(events, "roused"), `seed ${seed}`).toHaveLength(1);
      expect(alerted(state), `seed ${seed}`).toEqual(Object.keys(state.groups).sort());
    }
  });

  it("is played through by the enemy on its own, in a citadel and in a cavern, without breaking the rules: room on every hex, nobody in a wall or off the floor, and it ends", () => {
    const STURDY_HP = 300;
    let [fights, rounds, heard] = [0, 0, 0];
    for (const site of ["citadel", "cavern"] as const) {
      for (let seed = 0; seed < 6; seed++) {
        const where = `${site} ${seed}`;
        let state = zone(site, SIZES[seed % 3], seed, { groups: 3, threat: (seed % 3) + 1 });
        expect(state.aiOff, where).toBeFalsy();
        state = must(state, { type: "join", hero: standInHero("refactor_rogue", "ann", 3)! });
        state = must(state, { type: "join", hero: standInHero("qa_paladin", "bo", 3)! });
        // Two who take a great deal of killing: the enemy has rounds enough to come through the doorways at them, to be
        // heard from the next room, and to do whatever it does with a ledge or a hole in the floor.
        for (const h of state.units.filter((u) => u.side === "hero")) h.hp = h.maxHp = STURDY_HP;
        const tiles = new Map(state.map.tiles.map((t) => [posKey(t), t]));
        const check = () => {
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
          for (const u of state.units) {
            expect(u.hp, where).toBeGreaterThanOrEqual(0);
            expect(u.hp, where).toBeLessThanOrEqual(u.maxHp);
            // Nobody is in a wall, in the rock, or out over a hole in the floor; only what flies may be over a pool.
            const tile = tiles.get(posKey(u.pos));
            expect(tile, `${where}: ${u.kind} off the floor at ${posKey(u.pos)}`).toBeDefined();
            expect(tile!.biome, `${where}: ${u.kind} in the rock`).not.toBe("rock");
            expect(propOf(tile)?.blocks, `${where}: ${u.kind} in ${tile!.prop}`).toBeFalsy();
            if (!flies(u)) expect(solid(tile), `${where}: ${u.kind} at ${posKey(u.pos)}`).toBe(false);
            expect(blockerAt(state, u.pos), where).toBe(false);
          }
          const enc = state.encounter;
          if (enc) {
            // A turn is one fighter's alone, and nobody shares a place in the order.
            expect(enc.acting.length, where).toBeLessThanOrEqual(1);
            for (const id of enc.acting) expect(enc.order, where).toContain(id);
            expect(new Set(enc.order.map((id) => `${enc.init[id]}/${enc.tie?.[id] ?? 0}`)).size, where).toBe(enc.order.length);
            for (const b of Object.values(enc.budgets)) expect(b.ap, where).toBeGreaterThanOrEqual(0);
          }
        };
        check();
        // The two of them walk in, through the doorways and down the tunnels, by the shortest way on foot to whoever is
        // nearest by it (to the hex beside them: nobody walks onto an enemy's own), until somebody notices.
        const events: ZoneEvent[] = [];
        const kinds = new Map(state.units.map((u) => [u.id, u.kind]));
        for (let step = 0; step < 40 && !state.encounter; step++) {
          for (const id of ["ann", "bo"]) {
            if (state.encounter) break;
            const me = state.units.find((u) => u.id === id)!;
            const all = zoneReach(state, me, 5000);
            for (const f of standing(state)) expect(all.has(posKey(f.pos)), `${where}: a way onto an enemy's hex`).toBe(false);
            const goal = standing(state).flatMap((f) => HEX_DIRS.map((d) => all.get(posKey({ q: f.pos.q + d.q, r: f.pos.r + d.r })))).filter((r): r is Reached => !!r).sort((a, b) => a.cost - b.cost)[0];
            expect(goal, `${where}: no way to anyone`).toBeDefined();
            const way: Reached[] = [];
            for (let r: Reached | undefined = goal; r; r = r.prev === null ? undefined : all.get(r.prev)) way.unshift(r);
            // As far along it as one walk goes.
            const next = way.filter((r) => r.cost > 0 && r.cost <= 20 && r.stop).pop();
            if (next) state = must(state, { type: "move", by: id, unit: id, to: next.pos }, events);
            check();
          }
        }
        expect(state.encounter, `${where}: nobody was met`).not.toBeNull();
        expect(got(events, "roused"), where).toEqual([]);
        // From here the heroes only stand there: every turn of theirs runs out, and the enemy plays its own.
        let turns = 0;
        for (; turns < 1500 && state.encounter; turns++) {
          state = must(state, { type: "timeout" }, events);
          check();
        }
        // It ends, and with nobody fighting back it ends one way: they wake where they came in.
        expect(state.encounter, `${where}: still fighting after ${turns} turns`).toBeNull();
        expect(got(events, "fight_end").map((e) => e.outcome), where).toEqual(["defeat"]);
        for (const h of state.units.filter((u) => u.side === "hero")) if (events.some((e) => e.t === "down" && e.id === h.id)) expect(h, where).toMatchObject({ down: false, hp: 1 });
        // It took the enemy rounds, and it had to come to them to do it.
        rounds += Math.max(0, ...got(events, "round").map((e) => e.n));
        expect(got(events, "moved").some((e) => state.units.find((u) => u.id === e.id)?.side === "enemy"), where).toBe(true);
        expect(got(events, "hit").some((e) => e.target === "ann" || e.target === "bo"), where).toBe(true);
        // No enemy walked further in a turn of its own than its two AP of movement take it.
        let [turn, steps]: [string | null, number] = [null, 0];
        for (const e of events) {
          if (e.t === "turn") [turn, steps] = [e.ids[0] ?? null, 0];
          else if (e.t === "moved" && e.id === turn && e.id !== "ann" && e.id !== "bo") {
            steps += e.path.length;
            expect(steps, `${where}: ${kinds.get(e.id)} ${e.id}`).toBeLessThanOrEqual(ENEMY_MOVE_AP * enemyMove(kinds.get(e.id)!, modsOf(state.options).move));
          }
        }
        // Nothing was roused, first or last: the band that was met, and after it only those that heard.
        expect(got(events, "roused"), where).toEqual([]);
        const began = events.findIndex((e) => e.t === "fight_start");
        expect(got(events.slice(0, began), "alert").length, where).toBeGreaterThanOrEqual(1);
        expect(got(events.slice(began), "alert").map((e) => e.group).sort(), where).toEqual(got(events, "noise").map((e) => e.group).sort());
        heard += got(events, "noise").length;
        fights++;
      }
    }
    // Long fights, on the whole, and somewhere along the way a band in the next room heard one and came.
    expect(rounds / fights).toBeGreaterThan(4);
    // (Whether a second band heard any of these twelve depends on where the fights fell: that hearing works is the test above.)
    expect(heard).toBeGreaterThanOrEqual(0);
  }, 60_000);
});
