import { describe, expect, it } from "vitest";
import { hexDistance, posKey, type HexPos } from "@gantt-quest/core";
import { ATLAS_HOME, ATLAS_SPACING, atlasHex, atlasNode, atlasNodeById, atlasView, type AtlasCell, type AtlasNodeView } from "./atlas";
import { ATLAS_GLIMPSE, ATLAS_RIM, ATLAS_SIGHT, ATLAS_VIEW, atlasGround, atlasWorld, type AtlasWorld } from "./atlasMap";
import type { Tile } from "./map";

const SEEDS = ["CREWAA", "CREWBB", "ZGHPQH"];
const ring = (c: AtlasCell) => (Math.abs(c.q) + Math.abs(c.r) + Math.abs(c.q + c.r)) / 2;
/** A chart with the first few places cleared, each a route on from the last. */
function charted(seed: string, steps: number): AtlasNodeView[] {
  const cleared = new Set<string>();
  let from = ATLAS_HOME;
  for (let i = 0; i < steps; i++) {
    const next = atlasNodeById(seed, from)!.links.find((id) => id !== ATLAS_HOME && !cleared.has(id) && atlasNodeById(seed, id)!.ring >= atlasNodeById(seed, from)!.ring)!;
    cleared.add(next);
    from = next;
  }
  return atlasView(seed, cleared);
}
const tileAtHex = (world: AtlasWorld, hex: HexPos): Tile | undefined => world.map.tiles.find((t) => t.q === hex.q && t.r === hex.r);
/** Whether the cloud is lifted from a hex, by the rule: near enough the Harbor or somewhere cleared, or right by somewhere open. */
const seenBy = (nodes: AtlasNodeView[]) => {
  const reached = nodes.filter((n) => n.state === "harbor" || n.state === "cleared");
  const open = nodes.filter((n) => n.state === "open");
  return (hex: HexPos) => reached.some((n) => hexDistance(n.hex, hex) <= ATLAS_SIGHT) || open.some((n) => hexDistance(n.hex, hex) <= ATLAS_GLIMPSE);
};

describe("the world the atlas lies on", () => {
  it("is the same land for the same seed, and other land for another", () => {
    const spots = [{ q: 0, r: 0 }, { q: 7, r: -3 }, { q: -12, r: 20 }, { q: 31, r: 4 }, { q: -40, r: -9 }, { q: 3, r: 55 }];
    for (const seed of SEEDS) for (const p of spots) expect(atlasGround(seed, p)).toEqual(atlasGround(seed, p));
    const lie = (seed: string) => Array.from({ length: 400 }, (_, i) => atlasGround(seed, { q: (i % 20) * 3 - 30, r: Math.floor(i / 20) * 3 - 30 }).biome).join(" ");
    expect(lie("CREWAA")).not.toBe(lie("CREWBB"));
  });

  it("has seas, sand, grass, forest and hills, with the sea and the land each in a good share", () => {
    for (const seed of SEEDS) {
      const count: Record<string, number> = {};
      for (let q = -60; q <= 60; q += 2) for (let r = -60; r <= 60; r += 2) count[atlasGround(seed, { q, r }).biome] = (count[atlasGround(seed, { q, r }).biome] ?? 0) + 1;
      const total = Object.values(count).reduce((a, b) => a + b, 0);
      expect(Object.keys(count).sort(), seed).toEqual(["forest", "hills", "plains", "sand", "water"]);
      expect(count.water / total, seed).toBeGreaterThan(0.08);
      expect(count.water / total, seed).toBeLessThan(0.5);
      for (const kind of ["forest", "plains", "sand", "hills"]) expect(count[kind] / total, `${seed} ${kind}`).toBeGreaterThan(0.03);
    }
  });
});

describe("where the places lie", () => {
  const cells = (radius: number): AtlasCell[] => {
    const out: AtlasCell[] = [];
    for (let q = -radius; q <= radius; q++) for (let r = -radius; r <= radius; r++) if (ring({ q, r }) <= radius) out.push({ q, r });
    return out;
  };

  it("keeps every place a couple of hexes clear of every other, and the Harbor dead on its middle", () => {
    for (const seed of SEEDS) {
      expect(atlasHex(seed, { q: 0, r: 0 })).toEqual({ q: 0, r: 0 });
      const all = cells(9).map((c) => ({ c, hex: atlasHex(seed, c) }));
      const taken = new Map<string, AtlasCell>();
      for (const a of all) {
        for (const b of all) {
          if (a === b || ring({ q: a.c.q - b.c.q, r: a.c.r - b.c.r }) > 2) continue;
          expect(hexDistance(a.hex, b.hex), `${seed} ${a.c.q},${a.c.r} and ${b.c.q},${b.c.r}`).toBeGreaterThanOrEqual(2);
        }
        expect(taken.has(posKey(a.hex)), seed).toBe(false);
        taken.set(posKey(a.hex), a.c);
      }
    }
  });

  it("does not lay them out in ruled rows: along a row of cells they wander off the line", () => {
    for (const seed of SEEDS) {
      // A row of cells runs straight along r = 2; their places should not.
      const row = Array.from({ length: 13 }, (_, i) => atlasHex(seed, { q: i - 6, r: 2 }));
      const off = row.map((hex) => hex.r - 2 * ATLAS_SPACING);
      expect(new Set(off).size, seed).toBeGreaterThanOrEqual(3);
      expect(Math.max(...off) - Math.min(...off), seed).toBeGreaterThanOrEqual(2);
      // Nor are they evenly spaced along it.
      const gaps = row.slice(1).map((hex, i) => hexDistance(hex, row[i]));
      expect(new Set(gaps).size, seed).toBeGreaterThanOrEqual(3);
    }
  });

  it("runs no route further than a place and a half apart, save the one each place has toward the Harbor", () => {
    for (const seed of SEEDS) {
      let long = 0;
      let all = 0;
      for (const c of cells(7)) {
        const n = atlasNode(seed, c);
        for (const id of n.links) {
          const other = atlasNodeById(seed, id)!;
          all++;
          if (hexDistance(n.hex, other.hex) > ATLAS_SPACING + 1) long++;
          expect(hexDistance(n.hex, other.hex), `${n.id} to ${id}`).toBeLessThanOrEqual(ATLAS_SPACING * 2);
        }
      }
      // The long ones are only ever a place's own way in.
      expect(long / all, seed).toBeLessThan(0.3);
    }
  });
});

describe("the window a crew is shown", () => {
  it("is the same every time, holds nothing further than it reaches from its middle, and no hex twice", () => {
    for (const seed of SEEDS) {
      const nodes = charted(seed, 3);
      for (const centre of [{ q: 0, r: 0 }, { q: 17, r: -9 }, { q: 40, r: 25 }]) {
        const world = atlasWorld(seed, nodes, centre);
        expect(atlasWorld(seed, nodes, centre)).toEqual(world);
        // Whatever order the chart came in.
        expect(atlasWorld(seed, [...nodes].reverse(), centre).map.tiles).toEqual(world.map.tiles);
        expect(new Set(world.map.tiles.map(posKey)).size).toBe(world.map.tiles.length);
        for (const t of world.map.tiles) expect(hexDistance(t, centre), posKey(t)).toBeLessThanOrEqual(ATLAS_VIEW);
        // What is lit is ground it holds.
        const held = new Set(world.map.tiles.map(posKey));
        for (const hex of world.lit) expect(held.has(posKey(hex)), posKey(hex)).toBe(true);
      }
    }
  });

  it("shows the same hex of the world as the same ground, whichever window it falls in", () => {
    const seed = "CREWAA";
    const nodes = charted(seed, 4);
    const a = atlasWorld(seed, nodes, { q: 0, r: 0 });
    const b = atlasWorld(seed, nodes, { q: 11, r: -6 });
    const shared = a.map.tiles.filter((t) => tileAtHex(b, t));
    expect(shared.length).toBeGreaterThan(100);
    for (const ta of shared) {
      const tb = tileAtHex(b, ta)!;
      expect({ biome: ta.biome, h: ta.h, blocker: ta.blocker }, posKey(ta)).toEqual({ biome: tb.biome, h: tb.h, blocker: tb.blocker });
    }
  });

  it("gives every place they know somewhere to stand, and builds only the lighthouse and the sea caves' mouths", () => {
    for (const seed of SEEDS) {
      const nodes = charted(seed, 6);
      const world = atlasWorld(seed, nodes);
      for (const n of nodes) {
        if (n.state === "fogged") continue;
        const tile = tileAtHex(world, n.hex)!;
        expect(["plains", "sand"], `${n.id} on ${tile.biome}`).toContain(tile.biome);
        expect(tile.blocker, n.id).toBeUndefined();
      }
      const caves = nodes.filter((n) => n.state !== "fogged" && n.kind === "seacave");
      expect(world.map.pois.map((p) => p.kind).sort()).toEqual([...caves.map(() => "cave"), "lighthouse"].sort());
      expect(world.map.pois.find((p) => p.kind === "lighthouse")!.pos).toEqual({ q: 0, r: 0 });
      for (const c of caves) {
        const mouth = world.map.pois.find((p) => p.id === `node:${c.id}`)!;
        // In the crags at its back: beside the place, not on it.
        expect(hexDistance(mouth.pos, c.hex)).toBe(1);
        expect(tileAtHex(world, mouth.pos)!.biome).toBe("hills");
      }
    }
  });

  it("lifts the cloud round the Harbor and what is cleared, a little round what is open, and nowhere else", () => {
    for (const seed of SEEDS) {
      const nodes = charted(seed, 3);
      const world = atlasWorld(seed, nodes);
      const seen = seenBy(nodes);
      const lit = new Set(world.lit.map(posKey));
      // Every hex the window reaches: lit just when the rule says so.
      for (let q = -ATLAS_VIEW; q <= ATLAS_VIEW; q++) {
        for (let r = -ATLAS_VIEW; r <= ATLAS_VIEW; r++) {
          const hex = { q, r };
          if (hexDistance(hex, { q: 0, r: 0 }) > ATLAS_VIEW) continue;
          expect(lit.has(posKey(hex)), posKey(hex)).toBe(seen(hex));
        }
      }
      // The same rule, as rounds: one for the Harbor and each place cleared or open, as far as each lifts the cloud.
      const told = nodes.filter((n) => n.state !== "fogged");
      expect(world.clear.map((c) => posKey(c.hex)).sort()).toEqual(told.map((n) => posKey(n.hex)).sort());
      for (const c of world.clear) expect(c.reach).toBe(told.find((n) => posKey(n.hex) === posKey(c.hex))!.state === "open" ? ATLAS_GLIMPSE : ATLAS_SIGHT);
      // And no fog is handed over as ground: under the cloud there is nothing, or (at its edge) the land itself.
      expect(world.map.tiles.some((t) => t.biome === "fog")).toBe(false);
      expect(world.lit.length).toBeGreaterThan(150);
    }
  });

  it("hands over the land a few hexes past the lit ground, and no further", () => {
    for (const seed of SEEDS) {
      const nodes = charted(seed, 3);
      const world = atlasWorld(seed, nodes);
      const lit = world.lit;
      const litKeys = new Set(lit.map(posKey));
      const rim = world.map.tiles.filter((t) => !litKeys.has(posKey(t)));
      expect(rim.length).toBeGreaterThan(50);
      for (const t of rim) expect(Math.min(...lit.map((l) => hexDistance(l, t))), posKey(t)).toBeLessThanOrEqual(ATLAS_RIM);
    }
  });

  it("is nothing but cloud a long way from anything the crew knows", () => {
    const world = atlasWorld("CREWAA", charted("CREWAA", 2), { q: 900, r: -700 });
    expect(world.map.tiles).toEqual([]);
    expect(world.lit).toEqual([]);
    expect(world.clear).toEqual([]);
    expect(world.map.pois).toEqual([]);
  });

  it("a window off to one side still has the ground a node just outside it lights", () => {
    const seed = "CREWAA";
    const nodes = charted(seed, 2);
    // The Harbor is just off this window; its light reaches onto it.
    const centre = { q: ATLAS_VIEW + 3, r: 0 };
    const world = atlasWorld(seed, nodes, centre);
    expect(world.lit.some((hex) => hexDistance(hex, { q: 0, r: 0 }) <= ATLAS_SIGHT)).toBe(true);
    for (const hex of world.lit) expect(hexDistance(hex, centre)).toBeLessThanOrEqual(ATLAS_VIEW);
  });
});
