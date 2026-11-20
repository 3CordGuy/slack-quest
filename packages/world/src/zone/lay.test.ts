// Laying out a map (lay.ts) as a kind of place (sites.ts): ragged land with nothing beyond its edge, cliffs and the
// ladders up them, what stands on it (props.ts), the bands that hold it and the chests they guard. What the rules
// then make of that ground is in terrain.test.ts; that every post and chest can be walked to is in zone.test.ts.
// Places under a roof or under ground are laid by indoors.ts (indoors.test.ts): here they are held to whatever every
// map is held to, and where a guarantee is the open air's alone the test says so, and says what holds indoors instead.

import { describe, expect, it } from "vitest";
import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { ENEMIES } from "../content";
import { CLIMES, MOVE_COST, type Clime } from "../map";
import { makeRng } from "../rng";
import { ALERT_RANGE, ZONE_GRIDS, generateZone, zoneOptions } from "./gen";
import { HEX_DIRS, MAX_ELEV, ladderBetween, pitAt, solid } from "./geometry";
import { threatExtras } from "./kit";
import { LAY_GRIDS, layZone, type Laid } from "./lay";
import { PROPS, propOf } from "./props";
import { FACTIONS, LAIR_INSIDE, LOOKOUT_INSIDE, SITES, SITE_GROUNDS, SITE_IDS, backdropOf, bandOf, factionsOf, placeName, siteFor, siteInside, siteOpen, type Faction, type FactionId, type SiteDef, type SiteId } from "./sites";
import { createZone } from "./zone";
import type { ZoneOptions, ZoneSize } from "./types";

// ---------- helpers ----------

const SIZES: ZoneSize[] = ["small", "medium", "large"];
/** The sites out under the sky, and the ones under a roof or under ground. */
const OPEN = SITE_IDS.filter(siteOpen);
const INSIDE = SITE_IDS.filter(siteInside);
/** Which kind of indoors a site is: walled halls, caves, or neither. */
const kindOf = (site: SiteId) => (SITES[site] as SiteDef).inside;
const base = { size: "medium", biome: "meadow", groups: 3, elevation: 2, obstacles: 1, clear: 4, party: 2, threat: 2 } as const;
const options = (more: Record<string, unknown> = {}): ZoneOptions => zoneOptions({ ...base, ...more });
const lay = (seed: string, more: Record<string, unknown> = {}): Laid => layZone(seed, options(more));
const tilesOf = (plan: Laid) => new Map(plan.map.tiles.map((t) => [posKey(t), t]));
const around = (p: HexPos): HexPos[] => HEX_DIRS.map((d) => ({ q: p.q + d.q, r: p.r + d.r }));
const col = (p: HexPos) => p.q + Math.floor(p.r / 2);
/** On the grid, and a hex clear of its edge: where a map's hexes are laid. */
const inside = (plan: Laid, p: HexPos) => p.r >= 1 && p.r <= plan.map.grid.rows - 2 && col(p) >= 1 && col(p) <= plan.map.grid.cols - 2 - (p.r % 2 === 0 ? 0 : 1);
/** Everyone a faction can field. */
const ranks = (id: FactionId): string[] => {
  const f: Faction = FACTIONS[id];
  return [...f.front, ...f.shot, ...(f.heavy ?? [])];
};
/** How many stand in a band, for a party of this size at this threat (`more`: what a map's perils add). */
const bandSize = (party: number, threat: number, more = 0) => Math.max(2, Math.min(8, party + threatExtras(threat) + more + (party >= 3 ? 1 : 0)));
const count = <T>(list: T[], ok: (x: T) => boolean) => list.filter(ok).length;

// ---------- the grid, and the land on it ----------

describe("a map's grid", () => {
  it("is one of three sizes, bigger than the open cave floor's, and its hexes keep a hex clear of its edge", () => {
    expect(LAY_GRIDS).toEqual({ small: { cols: 28, rows: 22 }, medium: { cols: 36, rows: 26 }, large: { cols: 46, rows: 32 } });
    for (const size of SIZES) {
      const plan = lay(`grid-${size}`, { size });
      expect(plan.map.grid).toEqual(LAY_GRIDS[size]);
      for (const t of plan.map.tiles) expect(inside(plan, t), `${size} ${posKey(t)}`).toBe(true);
      expect(LAY_GRIDS[size].cols * LAY_GRIDS[size].rows).toBeGreaterThan(ZONE_GRIDS[size].cols * ZONE_GRIDS[size].rows);
    }
  });

  it("is laid for every map under the sky; open cave floor is made the old way, a full grid walled in rock, and is no site", () => {
    for (const biome of ["meadow", "woods", "shore"] as const) expect(generateZone("same", options({ biome }))).toEqual(layZone("same", options({ biome })));
    const cave = generateZone("same", options({ biome: "caves" }));
    expect(cave.map.grid).toEqual(ZONE_GRIDS.medium);
    expect(cave.map.tiles).toHaveLength(ZONE_GRIDS.medium.rows * ZONE_GRIDS.medium.cols - Math.floor(ZONE_GRIDS.medium.rows / 2));
    expect(cave.scene).toBeUndefined();
    expect(cave.map.tiles.some((t) => t.prop || t.ladder)).toBe(false);
    expect(cave.groups.every((g) => g.id === undefined)).toBe(true);
  });

  it("is the same map for the same seed and options, and another for another seed", () => {
    for (const size of SIZES) {
      expect(lay("again", { size })).toEqual(lay("again", { size }));
      expect(lay("again", { size }).map.tiles).not.toEqual(lay("another", { size }).map.tiles);
    }
  });

  it("is a large one, with a band more, on a Sprawling map; never more than eight bands", () => {
    const plain = lay("sprawl", { groups: 3, size: "small" });
    const big = lay("sprawl", { groups: 3, size: "small", mods: ["sprawling"] });
    expect(plain.map.grid).toEqual(LAY_GRIDS.small);
    expect(big.map.grid).toEqual(LAY_GRIDS.large);
    expect(big.groups).toHaveLength(4);
    expect(zoneOptions({ groups: 12 }).groups).toBe(8);
    expect(lay("crowd", { groups: 8, size: "large", mods: ["sprawling2"] }).groups.length).toBeLessThanOrEqual(8);
  });
});

describe("the land", () => {
  it("is a ragged run of ground, not the whole grid: somewhere between a quarter and two thirds of it, with nothing beyond its edge", () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 8; seed++) {
        const plan = lay(`land-${size}-${seed}`, { size, site: OPEN.filter((s) => s !== "cove")[seed] });
        const where = `${size} ${seed}`;
        const area = plan.map.grid.cols * plan.map.grid.rows;
        expect(plan.map.tiles.length / area, where).toBeGreaterThan(0.25);
        expect(plan.map.tiles.length / area, where).toBeLessThan(0.66);
        // Its edge is the edge of the world: beyond it there is no hex at all, and that is a pit like any other.
        const tiles = tilesOf(plan);
        const brink = plan.map.tiles.filter((t) => !solid(t) && around(t).some((n) => !tiles.has(posKey(n))));
        expect(brink.length, where).toBeGreaterThan(20);
        const off = around(brink[0]).find((n) => !tiles.has(posKey(n)))!;
        expect(pitAt(plan.map, off), where).toBe("void");
        expect(pitAt(plan.map, brink[0]), where).toBeNull();
      }
    }
  });

  it("stands in whole levels from 0 to the highest there is, and every hex says how high it is drawn", () => {
    for (const site of SITE_IDS) {
      const plan = lay(`levels-${site}`, { site, elevation: 3 });
      for (const t of plan.map.tiles) {
        expect(Number.isInteger(t.elev), site).toBe(true);
        expect(t.elev, site).toBeGreaterThanOrEqual(0);
        expect(t.elev, site).toBeLessThanOrEqual(MAX_ELEV);
        expect(t.h, site).toBeGreaterThan(0);
        if (t.biome === "water") expect(t.elev, site).toBe(0);
      }
      const top = Math.max(...plan.map.tiles.map((t) => t.elev ?? 0));
      // Under the sky there is height on it worth having: a cliff somewhere.
      if (siteOpen(site)) expect(top, site).toBeGreaterThanOrEqual(2);
      // Under ground the rock that walls it in stands as high as anything goes, and the floor no higher than a shelf.
      else if (kindOf(site) === "caves") {
        expect(top, site).toBe(MAX_ELEV);
        for (const t of plan.map.tiles) {
          if (t.biome === "rock") expect(t.elev, site).toBe(MAX_ELEV);
          else expect(t.elev, site).toBeLessThanOrEqual(2);
        }
      }
      // Under a roof the floor is level but for the dais (a step up) and a gallery (two): there is always the dais.
      else {
        expect(top, site).toBeGreaterThanOrEqual(1);
        expect(top, site).toBeLessThanOrEqual(2);
      }
    }
    expect(OPEN).toHaveLength(12);
    expect(INSIDE).toHaveLength(4);
    // The top of a crag is as high as ground goes.
    expect(Math.max(...lay("levels-crag", { site: "crag" }).map.tiles.map((t) => t.elev ?? 0))).toBe(MAX_ELEV);
  });

  it("has more high ground the craggier it is asked to be", () => {
    const high = (elevation: number) => {
      let n = 0;
      for (let seed = 0; seed < 12; seed++) n += count(lay(`high-${seed}`, { elevation, site: "wilds" }).map.tiles, (t) => (t.elev ?? 0) >= 2);
      return n;
    };
    expect(high(3)).toBeGreaterThan(high(1) * 1.5);
    expect(high(1)).toBeGreaterThanOrEqual(high(0));
  });

  it("at a cove lies in the sea: water drawn out from its shore, sand where the two meet, and the void only beyond that", () => {
    for (const size of SIZES) {
      for (let seed = 0; seed < 6; seed++) {
        const plan = lay(`cove-${size}-${seed}`, { size, biome: "shore", site: "cove" });
        const where = `${size} ${seed}`;
        expect(plan.scene).toEqual({ site: "cove", backdrop: "sea" });
        const tiles = tilesOf(plan);
        const sea = plan.map.tiles.filter((t) => t.biome === "water");
        expect(sea.length / plan.map.tiles.length, where).toBeGreaterThan(0.15);
        expect(plan.map.tiles.some((t) => t.biome === "sand"), where).toBe(true);
        for (const t of sea) expect(pitAt(plan.map, t), where).toBe("water");
        // Most of its shore is water, not the edge of the world. (Not all of it: the open ground laid round the start is
        // laid over the sea there, and what is built or bridged afterwards can reach past the water drawn round the land.)
        const shore = plan.map.tiles.filter((t) => t.biome !== "water");
        const wet = count(shore, (t) => around(t).some((n) => tiles.get(posKey(n))?.biome === "water"));
        const dry = count(shore, (t) => around(t).some((n) => !tiles.has(posKey(n)) && inside(plan, n)));
        expect(wet, where).toBeGreaterThan(3 * dry);
      }
    }
    // Anywhere else, the land floats: no sea is drawn round it.
    const keep = lay("no-sea", { site: "keep" });
    expect(keep.scene.backdrop).not.toBe("sea");
    expect(count(keep.map.tiles, (t) => t.biome === "water") / keep.map.tiles.length).toBeLessThan(0.1);
  });

  it("is painted in its climate, hex for hex: the ashlands' pools are lava, the frost has sheets of ice that do not melt", () => {
    for (const clime of CLIMES) {
      const plan = lay(`clime-${clime}`, { clime, site: "caldera" });
      const painted = clime === "greenwood" ? undefined : clime;
      expect(plan.map.tiles.every((t) => t.clime === painted), clime).toBe(true);
      const pools = plan.map.tiles.filter((t) => t.biome === "water");
      expect(pools.length, clime).toBeGreaterThan(0);
      for (const t of pools) expect(pitAt(plan.map, t), clime).toBe(clime === "ash" ? "lava" : "water");
    }
    const frost = lay("ice", { clime: "frost" });
    const ice = Object.entries(frost.surfaces ?? {});
    expect(ice.length).toBeGreaterThan(0);
    const tiles = tilesOf(frost);
    const posts = frost.groups.flatMap((g) => g.posts);
    for (const [key, s] of ice) {
      expect(s).toEqual({ kind: "ice", rounds: 99, by: null, lasting: true });
      const t = tiles.get(key)!;
      expect(solid(t)).toBe(false);
      expect(hexDistance(t, frost.start)).toBeGreaterThan(base.clear + 1);
      for (const p of posts) expect(hexDistance(t, p)).toBeGreaterThan(1);
    }
    // No ice anywhere warmer, unless a peril puts it there.
    expect(lay("ice", {}).surfaces).toBeUndefined();
    expect(Object.values(lay("ice", { mods: ["frozen"] }).surfaces ?? {}).every((s) => s.kind === "ice")).toBe(true);
  });
});

// ---------- cliffs, ladders, and what stands about ----------

describe("ladders", () => {
  it("stand on the low hex of a cliff, against the high one beside it: a way up for anyone on foot", () => {
    // Counted apart: the ones out in the open, and the ones up to a gallery or a shelf of rock.
    let ladders = 0;
    let indoors = 0;
    for (const site of SITE_IDS) {
      for (let seed = 0; seed < 4; seed++) {
        const plan = lay(`ladder-${site}-${seed}`, { site, elevation: 3, size: SIZES[seed % 3] });
        const tiles = tilesOf(plan);
        for (const t of plan.map.tiles) {
          if (t.ladder === undefined) continue;
          expect(t.ladder, site).toBeGreaterThan(0);
          expect(t.ladder, site).toBeLessThan(64);
          for (const [side, d] of HEX_DIRS.entries()) {
            if (!(t.ladder & (1 << side))) continue;
            if (siteOpen(site)) ladders++;
            else indoors++;
            const up = tiles.get(posKey({ q: t.q + d.q, r: t.r + d.r }));
            const where = `${site} ${seed} ${posKey(t)}`;
            expect(up, where).toBeDefined();
            expect((up!.elev ?? 0) - (t.elev ?? 0), where).toBeGreaterThanOrEqual(2);
            expect(solid(t) || solid(up), where).toBe(false);
            expect(ladderBetween(plan.map, t, up!), where).toBe(true);
            expect(ladderBetween(plan.map, up!, t), where).toBe(true);
          }
        }
      }
    }
    expect(ladders).toBeGreaterThan(OPEN.length * 4);
    expect(indoors).toBeGreaterThan(INSIDE.length * 4);
  });

  it("a keep's wall is three levels up, walked along its top, and climbed from the yard", () => {
    for (let seed = 0; seed < 8; seed++) {
      const plan = lay(`keep-${seed}`, { site: "keep" });
      const wall = plan.map.tiles.filter((t) => t.biome === "paved" && t.elev === 3);
      expect(wall.length, `seed ${seed}`).toBeGreaterThan(12);
      expect(count(plan.map.tiles, (t) => !!t.ladder), `seed ${seed}`).toBeGreaterThanOrEqual(3);
      // Somebody can stand on most of it: towers at its corners and by the gate, the walk between them open.
      expect(count(wall, (t) => !solid(t)), `seed ${seed}`).toBeGreaterThan(count(wall, (t) => t.prop === "tower"));
      expect(plan.map.tiles.some((t) => t.prop === "arch" && t.elev === 0), `seed ${seed}`).toBe(true);
    }
  });
});

describe("what stands on it", () => {
  it("is all of a kind the rules know, on ground and never on water; a chest or a post is never where something bars the way", () => {
    for (const site of SITE_IDS) {
      for (const clime of CLIMES) {
        const plan = lay(`props-${site}-${clime}`, { site, clime, obstacles: 3 });
        const tiles = tilesOf(plan);
        for (const t of plan.map.tiles) {
          if (!t.prop) continue;
          expect(PROPS[t.prop as keyof typeof PROPS], `${site}: ${t.prop}`).toBeDefined();
          expect(t.biome, `${site}: ${t.prop}`).not.toBe("water");
        }
        for (const p of [...plan.groups.flatMap((g) => g.posts), ...plan.map.pois.map((c) => c.pos)]) expect(propOf(tiles.get(posKey(p)))?.blocks, site).toBeFalsy();
      }
    }
  });

  it("is what the place is made of: a keep has its towers, a henge its stones, a fen its huts on legs", () => {
    const SIGNS: Record<SiteId, string[]> = {
      wilds: ["palisade", "tent", "campfire"],
      ruins: ["pillar", "wall", "arch"],
      keep: ["tower", "arch", "tent"],
      camp: ["palisade", "tent", "campfire"],
      henge: ["standing_stone"],
      boneyard: ["ribs", "skull"],
      icefield: ["standing_stone", "ice_spire"],
      fen: ["stilt_hut"],
      caldera: ["basalt", "brazier"],
      cove: ["palisade", "tent", "campfire"],
      crag: ["banner", "brazier"],
      den: ["ribs", "boulder"],
      // And under a roof or under ground: walls with torches on them, doorways and a high seat; the dead in their
      // boxes; rock grown up from the floor and cold light; what was eaten there.
      citadel: ["wall", "wall_torch", "arch", "pillar", "throne"],
      crypt: ["wall", "wall_torch", "arch", "sarcophagus", "bones"],
      cavern: ["stalagmite", "crystal"],
      hollow: ["bones", "ribs", "stalagmite"],
    };
    for (const site of SITE_IDS) {
      let whole = 0;
      for (let seed = 0; seed < 10; seed++) {
        const plan = lay(`made-${site}-${seed}`, { site });
        expect(plan.scene.site).toBe(site);
        const there = new Set(plan.map.tiles.map((t) => t.prop));
        if (SIGNS[site].every((p) => there.has(p))) whole++;
      }
      expect(whole, site).toBeGreaterThanOrEqual(9);
    }
  });

  it("is more of it the more cluttered the place is asked to be", () => {
    const clutter = (obstacles: number) => {
      let n = 0;
      for (let seed = 0; seed < 10; seed++) n += count(lay(`clutter-${seed}`, { obstacles, site: "wilds" }).map.tiles, (t) => !!propOf(t)?.blocks || t.biome === "forest");
      return n;
    };
    expect(clutter(3)).toBeGreaterThan(clutter(0) * 1.3);
  });

  it("the ring the party came through stands beside where they arrive, and there is one of it", () => {
    for (const site of SITE_IDS) {
      for (const size of SIZES) {
        const plan = lay(`gate-${site}-${size}`, { site, size });
        const gates = plan.map.tiles.filter((t) => t.prop === "waygate");
        expect(gates, `${site} ${size}`).toHaveLength(1);
        expect(hexDistance(gates[0], plan.start), `${site} ${size}`).toBe(1);
        expect(PROPS.waygate.blocks).toBe(true);
      }
    }
  });
});

// ---------- who holds it ----------

describe("the bands", () => {
  it("are numbered as they are posted, and a zone made of the plan knows them by those names", () => {
    for (const site of SITE_IDS) {
      const plan = lay(`names-${site}`, { site, groups: 4, size: "large" });
      expect(plan.groups.map((g) => g.id), site).toEqual(["band1", "band2", "band3", "band4"]);
      const zone = createZone("LAY", `names-${site}`, options({ site, groups: 4, size: "large" }));
      expect(Object.keys(zone.groups), site).toEqual(["band1", "band2", "band3", "band4"]);
      for (const g of plan.groups) {
        const members = zone.units.filter((u) => u.group === g.id);
        expect(members.map((u) => u.kind), site).toEqual(g.kinds);
        expect(members.map((u) => u.pos), site).toEqual(g.posts);
        expect(g.kinds.length, site).toBe(g.posts.length);
      }
      expect(zone.scene).toEqual(plan.scene);
    }
  });

  it("are as many as were asked for where there is room (a small map may not have it), and never more", () => {
    let short = 0;
    for (const site of SITE_IDS) {
      for (let seed = 0; seed < 6; seed++) {
        for (const size of SIZES) {
          const asked = 2 + (seed % 3);
          const plan = lay(`many-${site}-${seed}`, { site, size, groups: asked });
          expect(plan.groups.length, `${site} ${size} ${seed}`).toBeLessThanOrEqual(asked);
          expect(plan.groups.length, `${site} ${size} ${seed}`).toBeGreaterThanOrEqual(1);
          if (size === "large") expect(plan.groups.length, `${site} ${seed}`).toBe(asked);
          else if (plan.groups.length < asked && siteOpen(site)) short++;
        }
      }
    }
    // (It does happen, on the smaller maps out in the open: there is only so much ground clear of the start.)
    expect(short).toBeGreaterThan(0);
  });

  it("are each as many as the party (one more for three or four), one more for each step of threat, and one more again where a peril says so: two to eight", () => {
    expect([bandSize(1, 1), bandSize(1, 2), bandSize(2, 1), bandSize(2, 2), bandSize(2, 3), bandSize(3, 2), bandSize(4, 1), bandSize(4, 2), bandSize(4, 3)]).toEqual([2, 2, 2, 3, 4, 5, 5, 6, 7]);
    for (const party of [1, 2, 3, 4]) {
      for (const threat of [1, 2, 3]) {
        for (const mods of [[], ["numerous"]]) {
          // Every open-air site comes round, and with each a place under a roof or under ground.
          for (const site of [OPEN[(party * 3 + threat) % OPEN.length], INSIDE[(party * 3 + threat) % INSIDE.length]]) {
            const plan = lay(`size-${party}-${threat}`, { party, threat, mods, size: "large", site });
            const want = bandSize(party, threat, mods.length);
            const where = `${site} party ${party} threat ${threat} ${mods}`;
            expect(plan.groups.length, where).toBe(base.groups);
            // (In a cave one may now and then be left out of a band: a chamber has only so much floor, and no post is kept that cannot be walked to.)
            if (kindOf(site) === "caves") {
              for (const g of plan.groups) expect(g.kinds.length, where).toBeLessThanOrEqual(want);
              expect(count(plan.groups, (g) => g.kinds.length === want), where).toBeGreaterThanOrEqual(base.groups - 1);
            } else for (const g of plan.groups) expect(g.kinds.length, where).toBe(want);
          }
        }
      }
    }
    // However many are piled on, a band is eight at the most.
    for (const g of lay("size-most", { party: 4, threat: 3, mods: ["numerous3"], size: "large" }).groups) expect(g.kinds.length).toBeLessThanOrEqual(8);
  });

  it("are whoever lives at that kind of place in that climate, and nobody else", () => {
    for (const site of SITE_IDS) {
      for (const clime of CLIMES) {
        const painted = clime === "greenwood" ? undefined : clime;
        const local = factionsOf(site, painted);
        const plan = lay(`folk-${site}-${clime}`, { site, clime, groups: 4, size: "large", party: 4 });
        plan.groups.forEach((g, i) => {
          // Each band is one of the place's own, picked in turn.
          const faction = local[i % local.length];
          for (const kind of g.kinds) expect(ranks(faction), `${site} ${clime} band${i + 1}: ${kind}`).toContain(kind);
          for (const kind of g.kinds) expect(ENEMIES[kind].boss, kind).toBeFalsy();
        });
      }
    }
  });

  it("stand clear of where the party arrives, each on a hex of their own", () => {
    for (const site of SITE_IDS) {
      const plan = lay(`posts-${site}`, { site, groups: 5, party: 4, threat: 3 });
      const posts = plan.groups.flatMap((g) => g.posts);
      expect(new Set(posts.map(posKey)).size, site).toBe(posts.length);
      // Out in the open, well clear of it. Under a roof or under ground the party arrives in a room of its own, which
      // nobody is posted in: the nearest of them is in the next room, more than three hexes off.
      for (const p of posts) expect(hexDistance(p, plan.start), site).toBeGreaterThan(siteOpen(site) ? base.clear + ALERT_RANGE + 1 : 3);
      const chests = new Set(plan.map.pois.map((c) => posKey(c.pos)));
      for (const p of posts) expect(chests.has(posKey(p)), site).toBe(false);
    }
  });

  it("put those that shoot up high where the place has a height to hold: a keep's archers are on its wall", () => {
    let onTheWall = 0;
    for (let seed = 0; seed < 10; seed++) {
      const plan = lay(`wall-${seed}`, { site: "keep", party: 4 });
      const tiles = tilesOf(plan);
      const [first] = plan.groups;
      const up = (kind: string) => first.posts.filter((_, i) => first.kinds[i] === kind).map((p) => tiles.get(posKey(p))!.elev ?? 0);
      expect(up("archer").length, `seed ${seed}`).toBeGreaterThan(0);
      if (up("archer").every((e) => e === 3) && up("bandit").every((e) => e === 0)) onTheWall++;
    }
    expect(onTheWall).toBeGreaterThanOrEqual(9);
  });

  it("with a leader named: a boss stands in the first band, once, with the place's own behind it; a dummy stands alone; anything else brings a band of its own kind", () => {
    const lair = lay("named", { kinds: ["broodmother"], site: "den", groups: 3 });
    expect(lair.groups.map((g) => count(g.kinds, (k) => k === "broodmother"))).toEqual([1, 0, 0]);
    expect(lair.groups[0].kinds.length).toBe(bandSize(2, 2));
    const local = factionsOf("den", undefined);
    lair.groups.forEach((g, i) => { for (const kind of g.kinds) if (kind !== "broodmother") expect(ranks(local[i % local.length])).toContain(kind); });
    const yard = lay("named", { kinds: ["dummy"], groups: 2 });
    expect(yard.groups.map((g) => g.kinds)).toEqual([["dummy"], ["dummy"]]);
    const pack = lay("named", { kinds: ["wolf", "skeleton"], groups: 3, party: 4, threat: 1 });
    expect(pack.groups.map((g) => g.kinds)).toEqual([Array(5).fill("wolf"), Array(5).fill("skeleton"), Array(5).fill("wolf")]);
  });
});

describe("a band of a faction", () => {
  const first = <T,>(list: readonly T[]): T => list[0];

  it("is one that shoots for every three, the big one once there are four or more, and the rest in front", () => {
    for (const id of Object.keys(FACTIONS) as FactionId[]) {
      const f: Faction = FACTIONS[id];
      for (let size = 1; size <= 8; size++) {
        const band = bandOf(id, size, first);
        const where = `${id} ${size}`;
        expect(band, where).toHaveLength(size);
        const shot = f.shot.length > 0 ? Math.floor(size / 3) : 0;
        const heavy = size >= 4 && (f.heavy ?? []).length > 0 ? 1 : 0;
        expect(band.map((m) => m.role), where).toEqual([...Array(size - shot - heavy).fill("front"), ...Array(heavy).fill("heavy"), ...Array(shot).fill("shot")]);
        for (const m of band) expect(m.role === "front" ? f.front : m.role === "shot" ? f.shot : f.heavy, where).toContain(m.kind);
        for (const m of band) expect(ENEMIES[m.kind], m.kind).toBeDefined();
      }
    }
    expect(bandOf("raiders", 0, first)).toHaveLength(1);
    expect(bandOf("raiders", 6, first).map((m) => m.kind)).toEqual(["bandit", "bandit", "bandit", "brute", "archer", "archer"]);
    // Picked by the dice where a faction has more than one to pick from.
    const rng = makeRng(5);
    const kinds = new Set(Array.from({ length: 40 }, () => bandOf("coven", 2, rng.pick)[0].kind));
    expect([...kinds].sort()).toEqual(["spider", "wolf"]);
  });
});

// ---------- chests ----------

describe("the chests", () => {
  it("stand in the set pieces, each guarded by the band that holds it; the best of them, a strongbox, in what the place is named for", () => {
    for (const site of OPEN) {
      for (let seed = 0; seed < 6; seed++) {
        const plan = lay(`chest-${site}-${seed}`, { site, groups: 4 });
        const where = `${site} ${seed}`;
        const chests = plan.map.pois;
        expect(chests.length, where).toBeGreaterThanOrEqual(1);
        expect(new Set(chests.map((c) => c.id)).size, where).toBe(chests.length);
        expect(new Set(chests.map((c) => posKey(c.pos))).size, where).toBe(chests.length);
        const tiles = tilesOf(plan);
        for (const c of chests) {
          expect(c, where).toMatchObject({ kind: "cache", cleared: false, hidden: false });
          expect(["chest", "vault"], where).toContain(c.loot);
          expect(plan.groups.map((g) => g.id), where).toContain(c.guard);
          expect(solid(tiles.get(posKey(c.pos))), where).toBe(false);
          expect(hexDistance(c.pos, plan.start), where).toBeGreaterThan(base.clear);
          // Its guards are posted round it, not across the map.
          const guards = plan.groups.find((g) => g.id === c.guard)!;
          expect(Math.min(...guards.posts.map((p) => hexDistance(p, c.pos))), where).toBeLessThanOrEqual(6);
        }
        // One strongbox at the most, in the first set piece: unless that is only a camp, which has a plain chest like any other.
        const vaults = chests.filter((c) => c.loot === "vault");
        expect(vaults.length, where).toBe(SITES[site].pieces[0] === "camp" ? 0 : 1);
        if (vaults.length > 0) expect(vaults[0].guard, where).toBe("band1");
      }
    }
  });

  it("under a roof or under ground stand at the far end and at dead ends: one strongbox, the chief band's; a chest in a room nobody holds is nobody's", () => {
    let [guarded, free] = [0, 0];
    for (const site of INSIDE) {
      for (const size of SIZES) {
        for (let seed = 0; seed < 6; seed++) {
          const plan = lay(`chest-${site}-${size}-${seed}`, { site, size, groups: 4 });
          const where = `${site} ${size} ${seed}`;
          const chests = plan.map.pois;
          expect(chests.length, where).toBeGreaterThanOrEqual(1);
          expect(new Set(chests.map((c) => c.id)).size, where).toBe(chests.length);
          expect(new Set(chests.map((c) => posKey(c.pos))).size, where).toBe(chests.length);
          const tiles = tilesOf(plan);
          const bands = plan.groups.map((g) => g.id);
          for (const c of chests) {
            expect(c, where).toMatchObject({ kind: "cache", cleared: false, hidden: false });
            expect(["chest", "vault"], where).toContain(c.loot);
            expect(solid(tiles.get(posKey(c.pos))), where).toBe(false);
            // Never in the room the party arrives in.
            expect(hexDistance(c.pos, plan.start), where).toBeGreaterThan(3);
            // Guarded by a band there is, or by nobody: never by one that was not posted.
            if (c.guard === undefined) free++;
            else {
              guarded++;
              expect(bands, where).toContain(c.guard);
            }
            // A plain chest that has guards has them in the room with it, not across the map.
            if (c.guard !== undefined && c.loot === "chest") {
              const guards = plan.groups.find((g) => g.id === c.guard)!;
              expect(Math.min(...guards.posts.map((p) => hexDistance(p, c.pos))), where).toBeLessThanOrEqual(6);
            }
          }
          // The place always has its hoard: one strongbox, the chief band's.
          const vaults = chests.filter((c) => c.loot === "vault");
          expect(vaults.length, where).toBe(1);
          expect(vaults[0].guard, where).toBe("band1");
          // Under a roof it is on the dais, with the band that guards it round it.
          if (kindOf(site) === "halls") {
            expect(tiles.get(posKey(vaults[0].pos))!.elev, where).toBe(1);
            expect(Math.min(...plan.groups[0].posts.map((p) => hexDistance(p, vaults[0].pos))), where).toBeLessThanOrEqual(6);
          }
        }
      }
    }
    // Both happen: a chest with a band over it, and one at a dead end for whoever walks that far.
    expect(guarded).toBeGreaterThan(0);
    expect(free).toBeGreaterThan(0);
  });

  // Not yet so (indoors.ts, where "the place always has its hoard"). In a hall the strongbox is on the dais beside
  // band1 (above). In a cave, and most of all a hollow, whose last chamber has bones on every free hex, there is often
  // no hex left for it in the last chamber, and it is stood in whichever other chamber is furthest from the start,
  // still guarded by band1. For one:
  //   layZone("probe-hollow-small-9", zoneOptions({ size: "small", biome: "meadow", groups: 3, elevation: 2, obstacles: 1, clear: 4, party: 2, threat: 2, site: "hollow", clime: "ash" }))
  // has its strongbox at 14,18 and band1 posted at 19,4 17,4 20,3: fourteen hexes and more from what it guards.
  it.todo("under ground the strongbox stands in the last chamber, with the band that guards it");

  it("cannot be opened in a zone made of the plan until that band is down", () => {
    const zone = createZone("LAY", "guarded", options({ site: "keep" }));
    const chest = zone.map.pois.find((p) => p.kind === "cache")!;
    expect(zone.units.some((u) => u.group === chest.guard)).toBe(true);
    expect(zone.groups[chest.guard!]).toEqual({ alerted: false });
  });
});

// ---------- kinds of place ----------

describe("a kind of place", () => {
  it("follows from the ground and the climate: four it may be, the likeliest a little under half the time, and the last of them, one time in six, under a roof or under ground", () => {
    for (const clime of [undefined, ...CLIMES] as (Clime | undefined)[]) {
      // (High ground is the atlas's alone: a place on its hills. Its map is made as open ground, laid steep.)
      for (const biome of ["meadow", "woods", "shore", "caves", "heights"] as const) {
        const where = `${clime} ${biome}`;
        const picked = [0, 0.439, 0.44, 0.679, 0.68, 0.839, 0.84, 0.999].map((roll) => siteFor(biome, clime, "landfall", roll));
        // Four to pick from, in order of likelihood: the same roll, the same place.
        expect(picked[0], where).toBe(picked[1]);
        expect(picked[2], where).toBe(picked[3]);
        expect(picked[4], where).toBe(picked[5]);
        expect(picked[6], where).toBe(picked[7]);
        // Four different places, so the rolls part where they are said to: at 0.44, 0.68 and 0.84.
        expect(new Set(picked).size, where).toBe(4);
        for (const site of picked) expect(SITE_IDS, where).toContain(site);
        // The first three are out under the sky. The last is not, and 0.9 is a roll that finds it.
        for (const site of picked.slice(0, 6)) expect(siteOpen(site), `${where} ${site}`).toBe(true);
        expect(siteInside(picked[6]), `${where} ${picked[6]}`).toBe(true);
        expect(siteFor(biome, clime, "landfall", 0.9), where).toBe(picked[6]);
      }
      // A cave has no site of its own: it is reckoned as open ground.
      for (const roll of [0.1, 0.5, 0.7, 0.9]) expect(siteFor("caves", clime, "landfall", roll)).toBe(siteFor("meadow", clime, "landfall", roll));
    }
    // What is under a place suits what is over it: halls under a keep, vaults under the sands, rock under the woods.
    expect(siteFor("meadow", undefined, "landfall", 0.9)).toBe("citadel");
    expect(siteFor("woods", undefined, "landfall", 0.9)).toBe("cavern");
    expect(siteFor("shore", "dunes", "landfall", 0.9)).toBe("crypt");
    expect(siteFor("meadow", "mire", "landfall", 0.9)).toBe("cavern");
    expect(siteFor("shore", undefined, "landfall", 0)).toBe("cove");
    expect(siteFor("meadow", "mire", "landfall", 0)).toBe("fen");
    expect(siteFor("meadow", "ash", "landfall", 0)).toBe("caldera");
    expect(siteFor("woods", "dunes", "landfall", 0)).toBe("boneyard");
    expect(siteFor("meadow", "frost", "landfall", 0)).toBe("icefield");
    // In the hills it is a crag first, in every climate; and the ashlands, which have no sea, have no cove.
    for (const clime of CLIMES) expect(siteFor("heights", clime, "landfall", 0), clime).toBe("crag");
    for (const roll of [0, 0.5, 0.7, 0.9]) expect(siteFor("shore", "ash", "landfall", roll), `${roll}`).not.toBe("cove");
    // Left to itself a map picks one that suits its ground, the same one every time for the same seed.
    const sites = new Set(Array.from({ length: 30 }, (_, i) => lay(`pick-${i}`, { biome: "woods" }).scene.site));
    expect(lay("pick-3", { biome: "woods" }).scene.site).toBe(lay("pick-3", { biome: "woods" }).scene.site);
    expect(sites.size).toBeGreaterThan(1);
    for (const site of sites) expect(["wilds", "henge", "camp", "cavern"]).toContain(site);
  });

  it("a lookout is a crag, or four times in ten a citadel held from the inside, whatever the ground", () => {
    expect(LOOKOUT_INSIDE).toBe(0.4);
    for (const clime of [undefined, ...CLIMES] as (Clime | undefined)[]) {
      for (const biome of ["meadow", "woods", "shore", "caves"] as const) {
        for (const roll of [0, 0.2, LOOKOUT_INSIDE - 0.001]) expect(siteFor(biome, clime, "lookout", roll), `${clime} ${biome} ${roll}`).toBe("citadel");
        for (const roll of [LOOKOUT_INSIDE, 0.7, 0.999]) expect(siteFor(biome, clime, "lookout", roll), `${clime} ${biome} ${roll}`).toBe("crag");
      }
    }
  });

  it("a lair is a den in the open three times in ten; else it has gone under: a citadel on the shore, a hollow in the rock anywhere else", () => {
    expect(LAIR_INSIDE).toBe(0.7);
    for (const clime of [undefined, ...CLIMES] as (Clime | undefined)[]) {
      for (const biome of ["meadow", "woods", "shore", "caves"] as const) {
        for (const roll of [0, 0.3, LAIR_INSIDE - 0.001]) expect(siteFor(biome, clime, "lair", roll), `${clime} ${biome} ${roll}`).toBe(biome === "shore" ? "citadel" : "hollow");
        for (const roll of [LAIR_INSIDE, 0.85, 0.999]) expect(siteFor(biome, clime, "lair", roll), `${clime} ${biome} ${roll}`).toBe("den");
      }
    }
  });

  it("says what lies round its land: the sea at a cove, an abyss under ruins, lava under a caldera, and otherwise the climate's own", () => {
    for (const clime of [undefined, ...CLIMES] as (Clime | undefined)[]) {
      const sky = clime === "frost" ? "frost" : clime === "dunes" ? "dusk" : clime === "ash" ? "lava" : undefined;
      expect(backdropOf("cove", clime)).toBe("sea");
      // The abyss is under a ruin only where the climate has no sky of its own: ruins in the dunes are ruins in the sun.
      expect(backdropOf("ruins", clime)).toBe(sky ?? "abyss");
      expect(backdropOf("boneyard", clime)).toBe(clime === "frost" ? "frost" : clime === "ash" ? "lava" : "dusk");
      expect(backdropOf("caldera", clime)).toBe("lava");
      expect(backdropOf("keep", clime)).toBe(sky ?? "mist");
      // On a shore the sea is round the land, whatever the place is; save in the ashlands, which have no sea (it is
      // the fire there), in the mire, whose shore is pools in the mist, and over the abyss or the fire, which are a site's own.
      for (const site of ["keep", "camp", "boneyard", "icefield", "fen", "crag", "den"] as const) {
        expect(backdropOf(site, clime, "shore"), `${site} ${clime}`).toBe(clime === "ash" ? "lava" : clime === "mire" ? backdropOf(site, clime) : "sea");
      }
      expect(backdropOf("fen", "mire", "shore")).toBe("mist");
      expect(backdropOf("cove", "mire", "shore")).toBe("sea");
      expect(backdropOf("caldera", clime, "shore")).toBe("lava");
      expect(backdropOf("ruins", clime, "shore")).toBe(sky ?? "abyss");
      for (const ground of ["meadow", "woods", "caves"] as const) expect(backdropOf("keep", clime, ground)).toBe(sky ?? "mist");
      // Under a roof or under ground there is only the dark, whatever the weather is doing overhead, and wherever it stands.
      for (const site of INSIDE) for (const ground of [undefined, "shore", "meadow"] as const) expect(backdropOf(site, clime, ground), site).toBe("dark");
    }
    // A map on the shore is laid in that sea: water round it, and a beach where the land meets it.
    for (const site of ["camp", "keep", "boneyard"] as const) {
      const plan = lay(`shore-${site}`, { site, biome: "shore" });
      expect(plan.scene).toEqual({ site, backdrop: "sea" });
      expect(count(plan.map.tiles, (t) => t.biome === "water"), site).toBeGreaterThan(30);
      expect(count(plan.map.tiles, (t) => t.biome === "sand"), site).toBeGreaterThan(20);
      // The sand is low ground near the water: the beach, not the whole island. (Here and there something was
      // built over the water that a hex of it lay beside.)
      const tiles = tilesOf(plan);
      const sand = plan.map.tiles.filter((t) => t.biome === "sand");
      for (const t of sand) expect(t.elev, `${site} ${posKey(t)}`).toBe(0);
      expect(count(sand, (t) => around(t).flatMap((n) => [n, ...around(n)]).some((n) => tiles.get(posKey(n))?.biome === "water")) / sand.length, site).toBeGreaterThan(0.75);
      expect(sand.length, site).toBeLessThan(count(plan.map.tiles, (t) => t.biome !== "water") * 0.75);
    }
    for (const site of SITE_IDS) for (const clime of CLIMES) expect(lay(`back-${site}`, { site, clime }).scene).toEqual({ site, backdrop: backdropOf(site, clime === "greenwood" ? undefined : clime) });
  });

  it("is laid on its climate's own ground: sand in the dunes, mud in the mire's hollows, and neither dearer to cross than open ground", () => {
    for (const site of OPEN) {
      const where = `ground-${site}`;
      // In the dunes there is no grass to lay: all open ground is sand.
      const desert = lay(where, { site, clime: "dunes" });
      expect(count(desert.map.tiles, (t) => t.biome === "plains"), where).toBe(0);
      expect(count(desert.map.tiles, (t) => t.biome === "sand"), where).toBeGreaterThan(100);
      // In the mire the low ground by the water, and in the hollows, is mud: never a hex that stands above the rest.
      const bog = lay(where, { site, clime: "mire" });
      for (const t of bog.map.tiles) if (t.biome === "mud") expect(t.elev, where).toBe(0);
      // Nowhere else is either laid, save the sand of a beach (above).
      for (const clime of ["greenwood", "frost", "ash"] as const) {
        const plan = lay(where, { site, clime });
        expect(count(plan.map.tiles, (t) => t.biome === "mud"), `${where} ${clime}`).toBe(0);
        if (site !== "cove") expect(count(plan.map.tiles, (t) => t.biome === "sand"), `${where} ${clime}`).toBe(0);
      }
      // The same land, the same height and the same things standing on it as the greenwood's: only what it is made of differs.
      const green = tilesOf(lay(where, { site }));
      for (const t of desert.map.tiles) expect({ elev: green.get(posKey(t))?.elev, prop: green.get(posKey(t))?.prop }, where).toEqual({ elev: t.elev, prop: t.prop });
    }
    expect(count(lay("ground-fen", { site: "fen", clime: "mire" }).map.tiles, (t) => t.biome === "mud")).toBeGreaterThan(20);
    expect([MOVE_COST.sand, MOVE_COST.mud, MOVE_COST.plains]).toEqual([1, 1, 1]);
    // Under a roof or under ground nothing of this is laid: a crypt in the dunes is still paved.
    for (const site of INSIDE) for (const clime of CLIMES) expect(count(lay(`ground-${site}`, { site, clime }).map.tiles, (t) => t.biome === "sand" || t.biome === "mud" || t.biome === "plains"), `${site} ${clime}`).toBe(0);
  });

  it("is named with the country it is in, so the atlas can say what a map will be", () => {
    expect(placeName("ruins", "dunes", "meadow")).toBe("Desert ruins");
    expect(placeName("camp", "dunes", "shore")).toBe("Desert raiders' camp");
    expect(placeName("keep", "frost", "heights")).toBe("Frozen keep");
    expect(placeName("henge", "mire", "woods")).toBe("Marsh henge");
    expect(placeName("citadel", "ash", "meadow")).toBe("Ashland stronghold");
    // In the greenwood it is the ground that is said.
    expect(placeName("keep", undefined, "meadow")).toBe("Meadow keep");
    expect(placeName("henge", "greenwood", "woods")).toBe("Woodland henge");
    expect(placeName("camp", "greenwood", "shore")).toBe("Coastal raiders' camp");
    expect(placeName("ruins", "greenwood", "heights")).toBe("Hill ruins");
    // A place whose own name says where it is is not told twice; out of its own country it is.
    expect([placeName("icefield", "frost", "meadow"), placeName("fen", "mire", "shore"), placeName("caldera", "ash", "woods"), placeName("cove", undefined, "shore"), placeName("crag", "greenwood", "heights")]).toEqual(["Icefield", "Fen", "Caldera", "Cove", "Crag"]);
    expect([placeName("cove", "frost", "shore"), placeName("crag", "dunes", "heights")]).toEqual(["Frozen cove", "Desert crag"]);
    for (const site of SITE_IDS) for (const clime of CLIMES) for (const ground of SITE_GROUNDS) expect(placeName(site, clime, ground).toLowerCase(), `${site} ${clime} ${ground}`).toContain(SITES[site].name.toLowerCase());
  });

  it("is held by its own, with the climate's own in place of those that do not live there", () => {
    for (const site of SITE_IDS) {
      expect(factionsOf(site, undefined)).toEqual(SITES[site].factions);
      expect(factionsOf(site, "greenwood")).toEqual(SITES[site].factions);
      for (const clime of CLIMES) {
        const local = factionsOf(site, clime);
        expect(local).toHaveLength(SITES[site].factions.length);
        for (const f of local) expect(FACTIONS[f], `${site} ${clime} ${f}`).toBeDefined();
      }
      // Every piece it is built of is a piece there is, and everything strewn about it a thing the rules know.
      for (const p of SITES[site].scatter) expect(PROPS[p as keyof typeof PROPS], `${site} ${p}`).toBeDefined();
      // A place in the open is built of set pieces, three at the least; one under a roof or under ground of none (indoors.ts lays its rooms).
      if (siteOpen(site)) expect(SITES[site].pieces.length, site).toBeGreaterThanOrEqual(3);
      else expect(SITES[site].pieces, site).toEqual([]);
      expect(SITES[site].factions.length, site).toBeGreaterThanOrEqual(3);
    }
    // No wolves in the frost but frost wolves; no wolves in the mire at all.
    expect(factionsOf("wilds", "frost")).toEqual(["frost", "raiders", "spiders", "frost"]);
    expect(factionsOf("wilds", "mire")).toEqual(["spiders", "fen", "spiders", "coven"]);
    expect(factionsOf("den", "ash")).toEqual(["ash", "ash", "cult"]);
    // The same goes under ground: a hollow in the frost is the frost's, and what lives in the deep lives there in any climate.
    expect(factionsOf("hollow", "frost")).toEqual(["frost", "spiders", "frost"]);
    expect(factionsOf("crypt", "frost")).toEqual(["frostdead", "cult", "frostdead", "frostdead"]);
    expect(factionsOf("citadel", "mire")).toEqual(["fen", "giants", "cult", "fen"]);
    for (const clime of CLIMES) expect(count(factionsOf("cavern", clime), (f) => f === "deep"), clime).toBe(2);
    // Everyone a faction fields is an enemy there is.
    for (const id of Object.keys(FACTIONS) as FactionId[]) for (const kind of ranks(id)) expect(ENEMIES[kind], `${id} ${kind}`).toBeDefined();
    // And every one of the newcomers has a place in some faction's ranks.
    const fielded = new Set((Object.keys(FACTIONS) as FactionId[]).flatMap(ranks));
    for (const kind of ["spider", "frost_wolf", "ember_hound", "snow_bear", "wraith", "witch"]) expect(fielded.has(kind), kind).toBe(true);
  });
});
