import { describe, expect, it } from "vitest";
import { hexDistance } from "@gantt-quest/core";
import { ATLAS_HOME, ATLAS_SPACING, atlasCell, atlasClime, atlasLevel, atlasModCount, atlasNode, atlasNodeById, atlasOpen, atlasView, nodeOptions, type AtlasCell, type AtlasNode } from "./atlas";
import { CLIMES } from "./map";
import { ENEMIES } from "./content";
import { ZONE_MODS, createZone, generateZone, modEffect, standInHero, stepZone, zoneOptions, zoneReach } from "./zone";

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
      for (let q = -24; q <= 24; q++) {
        for (let r = -24; r <= 24; r += 3) {
          const node = atlasNode(seed, { q, r });
          expect(node.clime).toBe(node.kind === "harbor" ? "greenwood" : atlasClime(seed, node.hex));
          seen.add(node.clime);
          const options = nodeOptions(seed, node, 2);
          expect(options.clime).toBe(node.clime === "greenwood" ? undefined : node.clime);
          if (node.clime === "greenwood" || node.kind !== "landfall" || seen.size > 12) continue;
          // Its map's ground is all of that climate.
          const map = generateZone(`${seed}:${node.id}`, options).map;
          expect(map.tiles.every((t) => t.clime === node.clime), node.id).toBe(true);
        }
      }
    }
    expect([...seen].sort()).toEqual([...CLIMES].sort());
  });

  it("a map made with no climate, or the greenwood, has none on its tiles; nor has a cave under any", () => {
    expect(zoneOptions({ clime: "greenwood" }).clime).toBeUndefined();
    expect(zoneOptions({ clime: "tundra" }).clime).toBeUndefined();
    expect(zoneOptions({ clime: "frost" }).clime).toBe("frost");
    expect(generateZone("plain", zoneOptions({})).map.tiles.some((t) => t.clime)).toBe(false);
    expect(generateZone("under", zoneOptions({ biome: "caves", clime: "frost" })).map.tiles.some((t) => t.clime)).toBe(false);
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

  it("a lookout's map is high, broken ground; a lair's has the beast in it, alone, and a band besides", () => {
    const seed = "CREWAA";
    const all = nodes(seed, 14);
    const lookout = all.find((n) => n.kind === "lookout")!;
    expect(nodeOptions(seed, lookout, 2).elevation).toBe(3);
    for (const lair of all.filter((n) => n.kind === "lair").slice(0, 6)) {
      const options = nodeOptions(seed, lair, 3);
      expect(options.groups).toBe(2);
      expect(ENEMIES[options.kinds[0]].boss, lair.id).toBe(true);
      expect(ENEMIES[options.kinds[1]].boss ?? false, lair.id).toBe(false);
      expect(options.tier).toBe(lair.ring + 3);
      const state = createZone("TEST", `lair:${lair.id}`, options);
      const bosses = state.units.filter((u) => u.side === "enemy" && ENEMIES[u.kind].boss);
      expect(bosses.length, lair.id).toBe(1);
      expect(state.units.filter((u) => u.side === "enemy").length, lair.id).toBeGreaterThan(1);
    }
  });
});
