import { describe, expect, it } from "vitest";
import { hexDistance } from "@gantt-quest/core";
import { ATLAS_HOME, ATLAS_LANDS, ATLAS_SPACING, LAND_GROUND, atlasCell, atlasClime, atlasLevel, atlasLie, atlasModCount, atlasNode, atlasNodeById, atlasOpen, atlasView, nodeOptions, nodePlace, nodeSite, type AtlasCell, type AtlasLand, type AtlasNode } from "./atlas";
import { atlasGround } from "./atlasMap";
import { CLIMES, MOVE_COST, type Biome, type Clime } from "./map";
import { ENEMIES } from "./content";
import { SITES, SITE_IDS, ZONE_MODS, backdropOf, createZone, factionsOf, generateZone, modEffect, siteFor, siteInside, siteOpen, standInHero, stepZone, zoneOptions, zoneReach, FACTIONS, type SiteGround, type SiteId, type ZoneBiome } from "./zone";

const SEEDS = ["CREWAA", "CREWBB", "ZGHPQH"];
const ring = (c: AtlasCell) => (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2;
/** Every cell within `radius` of the Harbor. */
function cells(radius: number): AtlasCell[] {
  const out: AtlasCell[] = [];
  for (let q = -radius; q <= radius; q++) for (let r = -radius; r <= radius; r++) if (ring({ q, r }) <= radius) out.push({ q, r });
  return out;
}
const nodes = (seed: string, radius: number) => cells(radius).map((c) => atlasNode(seed, c));

describe("the chart", () => {
  it("is the same for the same seed, and another sea for another", () => {
    expect(nodes("CREWAA", 5)).toEqual(nodes("CREWAA", 5));
    const a = nodes("CREWAA", 5).map((n) => `${n.name}|${n.biome}|${n.links.join(" ")}`);
    const b = nodes("CREWBB", 5).map((n) => `${n.name}|${n.biome}|${n.links.join(" ")}`);
    expect(a).not.toEqual(b);
  });

  it("has the Harbor in the middle, with a route to each of the six landfalls round it", () => {
    for (const seed of SEEDS) {
      const home = atlasNodeById(seed, ATLAS_HOME)!;
      expect(home.kind).toBe("harbor");
      expect(home.links).toHaveLength(6);
      for (const id of home.links) {
        const n = atlasNodeById(seed, id)!;
        expect(n.ring).toBe(1);
        expect(n.kind).toBe("landfall");
        expect(n.mods).toEqual([]);
        expect(n.links).toContain(ATLAS_HOME);
      }
    }
  });

  it("runs every route both ways", () => {
    for (const seed of SEEDS) {
      for (const n of nodes(seed, 6)) for (const id of n.links) expect(atlasNodeById(seed, id)!.links, `${n.id} -> ${id}`).toContain(n.id);
    }
  });

  it("can be sailed from the Harbor to any node, never going further out than the node itself", () => {
    for (const seed of SEEDS) {
      const all = new Map(nodes(seed, 8).map((n) => [n.id, n]));
      const reached = new Set([ATLAS_HOME]);
      const queue = [ATLAS_HOME];
      for (let i = 0; i < queue.length; i++) {
        for (const id of all.get(queue[i])!.links) {
          // Only inward-or-level steps are needed: every node has a route a ring nearer.
          if (!all.has(id) || reached.has(id)) continue;
          reached.add(id);
          queue.push(id);
        }
      }
      expect(reached.size).toBe(all.size);
      for (const n of all.values()) if (n.ring > 0) expect(n.links.some((id) => all.get(id)?.ring === n.ring - 1), n.id).toBe(true);
    }
  });

  it("gives ways round as well as ways out: more routes than the one each node needs", () => {
    for (const seed of SEEDS) {
      const all = nodes(seed, 6);
      const routes = all.reduce((sum, n) => sum + n.links.length, 0) / 2;
      expect(routes).toBeGreaterThan(all.length * 1.3);
      expect(routes).toBeLessThan(all.length * 2.4);
    }
  });

  it("keeps its ground together in regions, with a sea cave here and there", () => {
    for (const seed of SEEDS) {
      const all = new Map(nodes(seed, 9).map((n) => [n.id, n]));
      const land = [...all.values()].filter((n) => n.kind === "landfall");
      let pairs = 0;
      let alike = 0;
      for (const n of land) {
        for (const id of n.links) {
          const other = all.get(id);
          if (!other || other.kind !== "landfall") continue;
          pairs++;
          if (other.biome === n.biome) alike++;
        }
      }
      // Three kinds of ground scattered at random would match about a third of the time.
      expect(alike / pairs).toBeGreaterThan(0.55);
      expect(new Set(land.map((n) => n.biome))).toEqual(new Set(["meadow", "woods", "shore"]));
      const caves = [...all.values()].filter((n) => n.kind === "seacave");
      expect(caves.length).toBeGreaterThan(5);
      expect(caves.length).toBeLessThan(all.size / 3);
      for (const c of caves) expect(c.biome).toBe("caves");
    }
  });

  it("is more dangerous the further out: a level a ring, and more modifiers", () => {
    expect([1, 2, 5, 12].map(atlasLevel)).toEqual([1, 2, 5, 12]);
    expect(atlasLevel(900)).toBe(40);
    for (const seed of SEEDS) {
      for (const n of nodes(seed, 9)) {
        if (n.ring === 0) continue;
        // A lair is a level above its ring.
        expect(n.level).toBe(atlasLevel(n.ring + (n.kind === "lair" ? 1 : 0)));
        const [lo, hi] = atlasModCount(n.ring);
        expect(n.mods.length).toBeGreaterThanOrEqual(lo);
        expect(n.mods.length).toBeLessThanOrEqual(hi);
        expect(new Set(n.mods).size).toBe(n.mods.length);
        expect(n.mods.filter((m) => modEffect(m).hazard).length).toBeLessThanOrEqual(1);
        // A sea cave's ground is the caverns' own: nothing that changes the ground is rolled there.
        if (n.kind === "seacave") for (const m of n.mods) expect(modEffect(m).kind).toBe("enemy");
      }
    }
    const far = nodes("CREWAA", 9).filter((n) => n.ring >= 7);
    expect(far.reduce((sum, n) => sum + n.mods.length, 0) / far.length).toBeGreaterThan(1.5);
  });

  it("gives no two landfalls side by side the same first word", () => {
    for (const seed of SEEDS) {
      const all = new Map(nodes(seed, 7).map((n) => [n.id, n]));
      const first = (n: AtlasNode) => n.name.split(" ")[0];
      for (const n of all.values()) {
        if (n.ring === 0) continue;
        const { q, r } = n.cell;
        for (const [dq, dr] of [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]]) {
          const other = all.get(`${q + dq},${r + dr}`);
          if (other && other.ring > 0) expect(first(other), `${n.id} beside ${other.id}`).not.toBe(first(n));
        }
      }
    }
  });

  it("names a node only by a cell's own id", () => {
    expect(atlasCell("3,-2")).toEqual({ q: 3, r: -2 });
    for (const bad of ["", "3", "3,-2,1", "03,2", "3, 2", "a,b", "99999,0", "600,0", null, 7, { q: 1, r: 1 }]) expect(atlasCell(bad), String(bad)).toBeNull();
    expect(atlasNodeById("CREWAA", "nope")).toBeNull();
  });
});

describe("what a crew sees of the chart", () => {
  const seed = "CREWAA";
  const byId = (view: ReturnType<typeof atlasView>) => new Map(view.map((n) => [n.id, n]));

  it("starts with the Harbor, the six landfalls round it open, and fog beyond", () => {
    const view = atlasView(seed, new Set());
    expect(view.filter((n) => n.state === "harbor").map((n) => n.id)).toEqual([ATLAS_HOME]);
    const open = view.filter((n) => n.state === "open");
    expect(open).toHaveLength(6);
    expect(view.filter((n) => n.state === "cleared")).toEqual([]);
    const fog = view.filter((n) => n.state === "fogged");
    expect(fog.length).toBeGreaterThan(0);
    for (const f of fog) {
      expect(f.ring).toBe(2);
      // Fog says where, and which open node a route runs to it from, and nothing else.
      expect(Object.keys(f).sort()).toEqual(["hex", "id", "links", "ring", "state"]);
      expect(f.links.length).toBeGreaterThan(0);
      for (const id of f.links) expect(open.some((o) => o.id === id)).toBe(true);
    }
  });

  it("opens the nodes a cleared one's routes run to, and pushes the fog back", () => {
    const first = atlasNodeById(seed, atlasNodeById(seed, ATLAS_HOME)!.links[0])!;
    const beyond = first.links.filter((id) => atlasNodeById(seed, id)!.ring === 2);
    expect(beyond.length).toBeGreaterThan(0);
    for (const id of beyond) expect(atlasOpen(seed, new Set(), id)).toBe(false);

    const cleared = new Set([first.id]);
    const view = byId(atlasView(seed, cleared));
    expect(view.get(first.id)!.state).toBe("cleared");
    for (const id of beyond) {
      expect(view.get(id)!.state).toBe("open");
      expect(atlasOpen(seed, cleared, id)).toBe(true);
    }
    // Every route shown ends at something shown.
    for (const n of view.values()) for (const id of n.links) expect(view.has(id), `${n.id} -> ${id}`).toBe(true);
  });

  it("never lets the Harbor, a cleared node or somewhere out of reach be opened", () => {
    const first = atlasNodeById(seed, ATLAS_HOME)!.links[0];
    expect(atlasOpen(seed, new Set(), first)).toBe(true);
    expect(atlasOpen(seed, new Set([first]), first)).toBe(false);
    expect(atlasOpen(seed, new Set(), ATLAS_HOME)).toBe(false);
    expect(atlasOpen(seed, new Set(), "6,0")).toBe(false);
    expect(atlasOpen(seed, new Set(), "not a node")).toBe(false);
  });
});

describe("a node's map", () => {
  const some = (seed: string, pick: (n: AtlasNode) => boolean) => nodes(seed, 9).filter((n) => n.ring > 0 && pick(n));

  it("is small and gentle beside the Harbor, and carries its level, tier and modifiers further out", () => {
    for (const seed of SEEDS) {
      for (const n of some(seed, (n) => n.ring === 1)) {
        expect(nodeOptions(seed, n, 2)).toMatchObject({ size: "small", threat: 1, level: 1, tier: 1, party: 2, biome: n.biome });
        expect(nodeOptions(seed, n, 2).mods).toBeUndefined();
      }
      for (const n of some(seed, (n) => n.ring >= 4 && n.kind === "landfall").slice(0, 12)) {
        const o = nodeOptions(seed, n, 3);
        expect(o).toMatchObject({ threat: 2, level: n.level, tier: n.ring, party: 3, biome: n.biome });
        expect(o.mods ?? []).toEqual(n.mods);
        expect(o.delve).toBeUndefined();
      }
      for (const n of some(seed, (n) => n.kind === "seacave").slice(0, 6)) expect(nodeOptions(seed, n, 2)).toMatchObject({ biome: "caves", delve: true, tier: n.ring });
    }
  });

  it("is the same map every time, with every band on it reachable from where the party lands", () => {
    const seed = "CREWAA";
    for (const n of some(seed, (n) => n.ring <= 6).filter((_, i) => i % 5 === 0)) {
      const options = nodeOptions(seed, n, 2);
      expect(nodeOptions(seed, n, 2)).toEqual(options);
      const made = createZone("TEST", `${seed}:${n.id}`, options);
      expect(createZone("TEST", `${seed}:${n.id}`, options)).toEqual(made);
      const enemies = made.units.filter((u) => u.side === "enemy");
      expect(enemies.length, n.id).toBeGreaterThan(0);
      // A sea cave is the caverns' own layout, locked doors and all: zone.test.ts walks those from the mouth.
      if (n.kind === "seacave") continue;
      const step = stepZone(made, { type: "join", hero: standInHero("qa_paladin", "ann", 1)! });
      if (!step.ok) throw new Error(step.error);
      const walker = step.state.units.find((u) => u.id === "ann")!;
      for (const e of enemies) {
        // The ground itself has to allow it: the enemy's own friends standing in the way do not count.
        const alone = { ...step.state, units: [walker, e] };
        expect([...zoneReach(alone, walker, 400).values()].some((r) => hexDistance(r.pos, e.pos) === 1), `${n.id}: ${e.kind} cut off`).toBe(true);
      }
    }
  });
});

describe("the climates", () => {
  const far = (step: number, reach: number): { q: number; r: number }[] => {
    const out = [];
    for (let q = -reach; q <= reach; q += step) for (let r = -reach; r <= reach; r += step) out.push({ q, r });
    return out;
  };

  it("leave the Harbor's own country greenwood, a few places out in every direction", () => {
    for (const seed of SEEDS) {
      for (const hex of far(1, 14)) {
        if (Math.abs(hex.q + hex.r) > 14) continue;
        expect(atlasClime(seed, hex), `${seed} ${hex.q},${hex.r}`).toBe("greenwood");
      }
    }
  });

  it("are all out there, each a fair share of the world, and the same for the same seed", () => {
    for (const seed of SEEDS) {
      const count: Record<string, number> = {};
      const spots = far(9, 520);
      for (const hex of spots) count[atlasClime(seed, hex)] = (count[atlasClime(seed, hex)] ?? 0) + 1;
      expect(Object.keys(count).sort(), seed).toEqual([...CLIMES].sort());
      for (const clime of CLIMES) expect(count[clime] / spots.length, `${seed} ${clime}`).toBeGreaterThan(0.05);
      // The greenwood is the most of it, but not most of the world.
      expect(count.greenwood / spots.length, seed).toBeLessThan(0.6);
      for (const hex of spots.slice(0, 200)) expect(atlasClime(seed, hex)).toBe(atlasClime(seed, hex));
    }
    const lie = (seed: string) => far(40, 400).map((hex) => atlasClime(seed, hex)).join(" ");
    expect(lie("CREWAA")).not.toBe(lie("CREWBB"));
  });

  it("lie in great tracts: a place and the next one over are nearly always in the same one", () => {
    for (const seed of SEEDS) {
      let same = 0;
      const spots = far(11, 400);
      for (const hex of spots) if (atlasClime(seed, hex) === atlasClime(seed, { q: hex.q + ATLAS_SPACING, r: hex.r })) same++;
      expect(same / spots.length, seed).toBeGreaterThan(0.84);
    }
  });

  it("are a place's own: it is named for its climate, and its map is made in it", () => {
    const seen = new Set<string>();
    for (const seed of SEEDS) {
      // A few maps laid in each climate, of the many places looked at.
      const laid: Record<string, number> = {};
      for (let q = -24; q <= 24; q++) {
        for (let r = -24; r <= 24; r += 3) {
          const node = atlasNode(seed, { q, r });
          // Its climate is that of the ground under it: the tract's own, save on open sand, which is the dunes' wherever it lies.
          const lie = atlasLie(seed, node.hex);
          expect(node.clime).toBe(node.kind === "harbor" ? "greenwood" : lie.clime);
          expect(lie.clime).toBe(lie.land === "sand" ? "dunes" : atlasClime(seed, node.hex));
          seen.add(node.clime);
          const options = nodeOptions(seed, node, 2);
          expect(options.clime).toBe(node.clime === "greenwood" ? undefined : node.clime);
          if (node.clime === "greenwood" || node.kind !== "landfall" || (laid[node.clime] ?? 0) >= 6) continue;
          laid[node.clime] = (laid[node.clime] ?? 0) + 1;
          // Its map's ground is all of that climate, and what lies round its land is the climate's own too.
          const plan = generateZone(`${seed}:${node.id}`, options);
          expect(plan.map.tiles.every((t) => t.clime === node.clime), node.id).toBe(true);
          expect(plan.scene, node.id).toEqual({ site: options.site, backdrop: backdropOf(options.site as SiteId, node.clime, options.biome) });
        }
      }
      expect(Object.keys(laid).sort(), seed).toEqual(CLIMES.filter((c) => c !== "greenwood").sort());
    }
    expect([...seen].sort()).toEqual([...CLIMES].sort());
  });

  it("each place is a kind of place, always the same one, that suits its ground and climate; who lives there is the climate's own", () => {
    const sites = new Set<string>();
    let [landfalls, under] = [0, 0];
    for (const seed of SEEDS) {
      for (const node of nodes(seed, 14)) {
        if (node.kind === "harbor") continue;
        const options = nodeOptions(seed, node, 2);
        // A sea cave is a delve, not a site.
        if (node.kind === "seacave") {
          expect(options.site, node.id).toBeUndefined();
          continue;
        }
        expect(options.site, node.id).toBe(nodeSite(seed, node));
        expect(nodeOptions(seed, node, 4).site, node.id).toBe(options.site);
        expect(SITE_IDS, node.id).toContain(options.site);
        sites.add(options.site!);
        if (node.kind === "landfall") {
          landfalls++;
          if (siteInside(options.site!)) under++;
        }
        // Whoever holds it is someone who lives in that climate: every band's faction is one there is.
        for (const faction of factionsOf(options.site as SiteId, node.clime)) expect(FACTIONS[faction], `${node.id} ${faction}`).toBeDefined();
      }
    }
    // Across three seas, every kind of place there is turns up somewhere.
    expect([...sites].sort()).toEqual([...SITE_IDS].sort());
    // About one landfall in six is under a roof or under ground; the rest are out under the sky.
    expect(under / landfalls).toBeGreaterThan(0.12);
    expect(under / landfalls).toBeLessThan(0.2);
  });

  it("a map made with no climate, or the greenwood, has none on its tiles; nor has a cave under any", () => {
    expect(zoneOptions({ clime: "greenwood" }).clime).toBeUndefined();
    expect(zoneOptions({ clime: "tundra" }).clime).toBeUndefined();
    expect(zoneOptions({ clime: "frost" }).clime).toBe("frost");
    expect(generateZone("plain", zoneOptions({})).map.tiles.some((t) => t.clime)).toBe(false);
    expect(generateZone("under", zoneOptions({ biome: "caves", clime: "frost" })).map.tiles.some((t) => t.clime)).toBe(false);
  });
});

describe("the land a place stands on", () => {
  const MANY = [...SEEDS, "HEYLET", "QWERTY", "A1", "B2", "C3"];
  /**
   * What each kind of tile the atlas draws means for a map made on it: the ground the place is picked for
   * (zone/sites.ts), and the ground its map is laid as. Written out here, not read from the rules.
   */
  const TABLE: Record<AtlasLand, { ground: SiteGround; biome: ZoneBiome }> = {
    sea: { ground: "shore", biome: "shore" },
    strand: { ground: "shore", biome: "shore" },
    sand: { ground: "meadow", biome: "meadow" },
    grass: { ground: "meadow", biome: "meadow" },
    forest: { ground: "woods", biome: "woods" },
    hills: { ground: "heights", biome: "meadow" },
  };
  /** What a place on each ground in each climate most often is: the place a player would expect of the tile. */
  const LIKELIEST: Record<Clime, Record<SiteGround, SiteId>> = {
    greenwood: { shore: "cove", meadow: "keep", woods: "wilds", heights: "crag" },
    frost: { shore: "cove", meadow: "icefield", woods: "icefield", heights: "crag" },
    dunes: { shore: "cove", meadow: "boneyard", woods: "boneyard", heights: "crag" },
    mire: { shore: "fen", meadow: "fen", woods: "fen", heights: "crag" },
    ash: { shore: "caldera", meadow: "caldera", woods: "caldera", heights: "crag" },
  };
  /** The tile the atlas draws for each land: the ashlands have no water, and their sea is drawn as low, bare ground. */
  const drawn = (land: AtlasLand, clime: Clime): Biome => (land === "sea" ? (clime === "ash" ? "sand" : "water") : land === "strand" || land === "sand" ? "sand" : land === "grass" ? "plains" : land);
  const ROLLS = [0, 0.5, 0.7, 0.9];
  /** What says a place's environment: the same for the same place, always. */
  const told = (seed: string, n: AtlasNode) => [n.id, n.land, n.clime, n.biome, n.name, n.kind === "harbor" || n.kind === "seacave" ? "" : nodeSite(seed, n)].join("|");

  it("has a map environment for every kind of tile the atlas can draw under a place", () => {
    expect(Object.keys(TABLE).sort()).toEqual([...ATLAS_LANDS].sort());
    expect(LAND_GROUND).toEqual(Object.fromEntries(ATLAS_LANDS.map((land) => [land, TABLE[land].ground])));
    const seen = new Set<string>();
    for (const seed of MANY) {
      for (let q = -520; q <= 520; q += 13) {
        for (let r = -520; r <= 520; r += 13) {
          const hex = { q, r };
          const lie = atlasLie(seed, hex);
          seen.add(`${lie.clime} ${lie.land}`);
          // What is drawn there is that land, in that climate: the same reckoning, not a second one.
          const tile = atlasGround(seed, hex);
          if (tile.biome !== drawn(lie.land, lie.clime) || (tile.clime ?? "greenwood") !== lie.clime) throw new Error(`${seed} ${q},${r}: ${lie.clime} ${lie.land} is drawn as ${tile.clime ?? "greenwood"} ${tile.biome}`);
        }
      }
    }
    // Every land is found in every climate, save open sand, which is the dunes' alone.
    const every = CLIMES.flatMap((clime) => ATLAS_LANDS.filter((land) => land !== "sand" || clime === "dunes").map((land) => `${clime} ${land}`));
    expect([...seen].sort()).toEqual(every.sort());
    // And each of them is some kind of place, whatever is rolled: the likeliest, the one a player would expect.
    for (const kind of every) {
      const [clime, land] = kind.split(" ") as [Clime, AtlasLand];
      const picked = ROLLS.map((roll) => siteFor(TABLE[land].ground, clime, "landfall", roll));
      for (const site of picked) expect(SITE_IDS, kind).toContain(site);
      expect(picked[0], kind).toBe(LIKELIEST[clime][TABLE[land].ground]);
      expect(siteInside(picked[3]), kind).toBe(true);
    }
  });

  it("makes every place's map of the tile under it: its climate, its ground and so its kind of place, on any chart", () => {
    const found = new Set<string>();
    const country: Record<Clime, RegExp> = { greenwood: /^(Meadow |Woodland |Coastal |Hill |Cove$|Crag$|Wilds$)/, frost: /^(Frozen |Icefield$)/, dunes: /^Desert /, mire: /^(Marsh |Fen$)/, ash: /^(Ashland |Caldera$)/ };
    for (const seed of MANY) {
      for (const node of nodes(seed, 12)) {
        if (node.kind === "harbor") continue;
        const where = `${seed} ${node.id}`;
        const lie = atlasLie(seed, node.hex);
        expect({ land: node.land, clime: node.clime }, where).toEqual({ land: lie.land, clime: lie.clime });
        const options = nodeOptions(seed, node, 2);
        expect(options.clime, where).toBe(lie.clime === "greenwood" ? undefined : lie.clime);
        // A sea cave is a delve wherever it is, dressed for its climate.
        if (node.kind === "seacave") {
          expect(options, where).toMatchObject({ biome: "caves", delve: true });
          expect(nodePlace(seed, node), where).toBe("Sea cave");
          continue;
        }
        const { ground, biome } = TABLE[lie.land];
        expect(node.biome, where).toBe(biome);
        expect(options.biome, where).toBe(biome);
        expect(options.site, where).toBe(nodeSite(seed, node));
        if (node.kind === "landfall") {
          expect(ROLLS.map((roll) => siteFor(ground, lie.clime, "landfall", roll)), where).toContain(options.site);
          // Up in the hills the ground is as steep as ground gets.
          if (ground === "heights") expect(options.elevation, where).toBe(3);
          found.add(`${lie.clime} ${ground}`);
        }
        // What the atlas calls it says the country it is in, and what kind of place it is.
        expect(nodePlace(seed, node), where).toMatch(country[lie.clime]);
        expect(nodePlace(seed, node).toLowerCase(), where).toContain(SITES[options.site as SiteId].name.toLowerCase());
      }
    }
    // Landfalls on every ground of every climate turned up among them.
    expect(found.size).toBe(CLIMES.length * 4);
  });

  it("gives the same place the same environment every time, whatever was asked for first", () => {
    for (const seed of MANY.slice(0, 4)) {
      const first = nodes(seed, 8).map((n) => told(seed, n));
      // Asked for again, from the far side first: the same.
      const again = [...cells(8)].reverse().map((c) => atlasNode(seed, c)).reverse().map((n) => told(seed, n));
      expect(again).toEqual(first);
      // And with the noise worked out afresh or kept from the last hex: the same.
      const memo = new Map<string, number>();
      for (const n of nodes(seed, 6)) expect(atlasLie(seed, n.hex, memo), n.id).toEqual(atlasLie(seed, n.hex));
      for (const n of nodes(seed, 6)) if (n.kind !== "harbor") expect(nodeOptions(seed, n, 3), n.id).toEqual(nodeOptions(seed, n, 3));
    }
  });

  it("lays a map that is that ground: sand in the desert, the sea round a shore, mud in the mire, and no step dearer than it was", () => {
    const laid = new Set<string>();
    for (const seed of MANY) {
      for (const node of nodes(seed, 12)) {
        if (node.kind !== "landfall") continue;
        const options = nodeOptions(seed, node, 2);
        const ground = LAND_GROUND[node.land];
        const kind = `${node.clime} ${ground}`;
        if (siteInside(options.site!) || laid.has(kind)) continue;
        laid.add(kind);
        const plan = generateZone(`${seed}:${node.id}`, options);
        const biomes = new Set(plan.map.tiles.map((t) => t.biome));
        expect(plan.map.tiles.every((t) => (t.clime ?? "greenwood") === node.clime), kind).toBe(true);
        // A desert is sand underfoot: no grass anywhere on it.
        if (node.clime === "dunes") {
          expect(biomes.has("plains"), kind).toBe(false);
          expect(biomes.has("sand"), kind).toBe(true);
        }
        // A shore stands in the sea, with a beach where the land meets it. (The ashlands have no sea: theirs stands
        // in the fire. Nor is the mire's open water: its shore is mud and black pools, in the mist, save at a cove.)
        if (ground === "shore" && node.clime !== "ash" && node.clime !== "mire") {
          expect(plan.scene!.backdrop, kind).toBe("sea");
          expect(plan.map.tiles.filter((t) => t.biome === "sand").length, kind).toBeGreaterThan(12);
        } else if (ground === "shore") expect(plan.scene!.backdrop, kind).toBe(node.clime === "ash" ? "lava" : options.site === "cove" ? "sea" : "mist");
        else expect(plan.scene!.backdrop, kind).not.toBe("sea");
        if (node.clime === "mire") expect(biomes.has("mud"), kind).toBe(true);
        // Whatever ground is laid costs what open ground costs to cross (only trees cost more, and water and rock bar the way).
        for (const b of biomes) if (b !== "forest" && b !== "water" && b !== "rock") expect(MOVE_COST[b], `${kind} ${b}`).toBe(1);
      }
    }
    expect(laid.size).toBe(CLIMES.length * 4);
  });
});

describe("lookouts and lairs", () => {
  it("are out there from the second and third rings, a few in a hundred, and named for what they are", () => {
    for (const seed of SEEDS) {
      const all = nodes(seed, 14).filter((n) => n.ring > 0);
      const share = (kind: AtlasNode["kind"]) => all.filter((n) => n.kind === kind).length / all.length;
      expect(share("lookout"), seed).toBeGreaterThan(0.03);
      expect(share("lookout"), seed).toBeLessThan(0.12);
      expect(share("lair"), seed).toBeGreaterThan(0.03);
      expect(share("lair"), seed).toBeLessThan(0.12);
      expect(all.some((n) => n.ring < 2 && n.kind !== "landfall"), seed).toBe(false);
      expect(all.some((n) => n.ring < 3 && n.kind === "lair"), seed).toBe(false);
      for (const n of all.filter((n) => n.kind === "lookout")) expect(n.name).toMatch(/ (Lookout|Watch|Height|Crag|Beacon|Tor)$/);
      for (const n of all.filter((n) => n.kind === "lair")) expect(n.name).toMatch(/ (Den|Lair|Warren|Roost|Hold|Maw)$/);
    }
  });

  it("a lookout's map is a crag, high and broken, or a citadel held from the inside: the crag the likelier", () => {
    const seed = "CREWAA";
    const lookouts = nodes(seed, 14).filter((n) => n.kind === "lookout");
    const of = (site: string) => lookouts.filter((n) => nodeSite(seed, n) === site);
    // One or the other, and nothing else; more of them crags than not, but a fair few held from inside.
    expect(of("crag").length + of("citadel").length).toBe(lookouts.length);
    expect(of("crag").length).toBeGreaterThan(of("citadel").length);
    expect(of("citadel").length / lookouts.length).toBeGreaterThan(0.2);
    for (const lookout of lookouts) expect(nodeOptions(seed, lookout, 2), lookout.id).toMatchObject({ elevation: 3, size: "medium", site: nodeSite(seed, lookout) });
    for (const site of ["crag", "citadel"]) {
      for (const lookout of of(site).slice(0, 2)) {
        const state = createZone("TEST", `lookout:${lookout.id}`, nodeOptions(seed, lookout, 2));
        expect(state.scene, lookout.id).toEqual({ site, backdrop: backdropOf(site as SiteId, lookout.clime, lookout.biome) });
        expect(siteInside(state.scene!.site), lookout.id).toBe(site === "citadel");
        // Nobody on a lookout is a boss, wherever it is held from.
        expect(state.units.some((u) => u.side === "enemy" && ENEMIES[u.kind].boss), lookout.id).toBe(false);
      }
    }
  });

  it("a lair's map is a den in the open, a hollow in the rock, or on the shore the halls of a citadel; the beast is in its first band, one of it, and the place's own in every other", () => {
    const seed = "CREWAA";
    const lairs = nodes(seed, 14).filter((n) => n.kind === "lair");
    const of = (site: string) => lairs.filter((n) => nodeSite(seed, n) === site);
    for (const lair of lairs) {
      const options = nodeOptions(seed, lair, 3);
      const site = nodeSite(seed, lair);
      // The beast alone is named: the bands round it are whoever lives there.
      expect(options).toMatchObject({ groups: 3, site, tier: lair.ring + 3 });
      expect(["den", "hollow", "citadel"], lair.id).toContain(site);
      // Gone under, it is in the rock; only on the shore is there a citadel for it to have taken.
      if (lair.biome === "shore") expect(site, lair.id).not.toBe("hollow");
      else expect(site, lair.id).not.toBe("citadel");
      expect(options.kinds, lair.id).toHaveLength(1);
      expect(ENEMIES[options.kinds[0]].boss, lair.id).toBe(true);
      // In the mire it is the broodmother, whatever the ground.
      if (lair.clime === "mire") expect(options.kinds[0], lair.id).toBe("broodmother");
    }
    // All three are out there, and most lairs have gone under.
    for (const site of ["den", "hollow", "citadel"]) expect(of(site).length, site).toBeGreaterThan(0);
    expect(of("den").length).toBeLessThan(lairs.length / 2);
    for (const site of ["den", "hollow", "citadel"]) {
      for (const lair of of(site).slice(0, 4)) {
        const options = nodeOptions(seed, lair, 3);
        const state = createZone("TEST", `lair:${lair.id}`, options);
        expect(state.scene, lair.id).toEqual({ site, backdrop: backdropOf(site as SiteId, lair.clime, lair.biome) });
        expect(siteOpen(state.scene!.site), lair.id).toBe(site === "den");
        const foes = state.units.filter((u) => u.side === "enemy");
        const bosses = foes.filter((u) => ENEMIES[u.kind].boss);
        // Under a roof or under ground as much as in the open: the beast once, in the first band (the one in the great hall, or the last chamber).
        expect(bosses.map((u) => [u.kind, u.group]), lair.id).toEqual([[options.kinds[0], "band1"]]);
        // It does not stand alone: a band of the place's own is in the den with it, and there are other bands besides.
        const local = factionsOf(site as SiteId, lair.clime).flatMap((f): string[] => [...FACTIONS[f].front, ...FACTIONS[f].shot, ...(FACTIONS[f] as { heavy?: string[] }).heavy ?? []]);
        expect(foes.filter((u) => u.group === "band1").length, lair.id).toBeGreaterThan(1);
        for (const u of foes) if (u !== bosses[0]) expect(local, `${lair.id} ${u.kind}`).toContain(u.kind);
        expect(Object.keys(state.groups).length, lair.id).toBeGreaterThan(1);
        // Indoors the beast is as far in as the place goes: further from the way in than anyone of another band's.
        if (site !== "den") {
          const far = (u: { pos: { q: number; r: number } }) => hexDistance(u.pos, state.start);
          expect(far(bosses[0]), lair.id).toBeGreaterThan(8);
        }
      }
    }
  });
});
