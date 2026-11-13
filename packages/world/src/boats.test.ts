import { describe, expect, it } from "vitest";
import { FISH } from "./fishcatalog";
import { FISH_SPOTS, rollCatch, vesselProblem } from "./fishing";
import { gatherView, stepGather } from "./gather";
import { HARBOR_PIERS, HARBOR_ROCKS, HARBOR_WRECK, coastal, generateHarbor, harborPath, seaEdge, waterSpotAt } from "./harbor";
import { VESSEL_OF, bestVessel, FURNISHINGS } from "./hut";
import { hutRoom, placeProblem } from "./hutroom";
import { makeRng } from "./rng";
import { startSitting } from "./sitting";
import { tileAt } from "./map";

const map = generateHarbor();
const water = map.tiles.filter((t) => t.biome === "water");
const pier = HARBOR_PIERS[1];
const edge = water.find((t) => seaEdge(map, t))!;
const coast = water.find((t) => coastal(map, t) && !HARBOR_ROCKS.some((r) => r.q === t.q && r.r === t.r))!;
const open = water.find((t) => !coastal(map, t) && !seaEdge(map, t))!;

describe("boats", () => {
  it("are crafted, never placed, and the rowboat beats the barrel", () => {
    expect(VESSEL_OF.float_barrel).toBe("barrel");
    expect(FURNISHINGS.rowboat.kind).toBe("vessel");
    expect(bestVessel(["float_barrel", "rowboat"])).toBe("rowboat");
    expect(bestVessel(["float_barrel"])).toBe("barrel");
    expect(bestVessel(["chair"])).toBeNull();
  });

  it("keep a hero off the water without one", () => {
    expect(harborPath(map, pier, coast)).toBeNull();
  });

  it("let a barrel along the coast but not out into open water", () => {
    expect(harborPath(map, pier, coast, "barrel")).not.toBeNull();
    expect(harborPath(map, pier, edge, "barrel")).toBeNull();
    const route = harborPath(map, pier, coast, "barrel")!;
    for (const p of route) if (tileAt(map, p)?.biome === "water") expect(coastal(map, p)).toBe(true);
  });

  it("let a rowboat anywhere on the water, but never onto the rocks or the wreck", () => {
    expect(harborPath(map, pier, edge, "rowboat")).not.toBeNull();
    expect(harborPath(map, pier, open, "rowboat")).not.toBeNull();
    expect(harborPath(map, pier, HARBOR_WRECK, "rowboat")).toBeNull();
    for (const r of HARBOR_ROCKS) expect(harborPath(map, pier, r, "rowboat")).toBeNull();
  });

  it("names the water a hero is on, with the wreck's own", () => {
    const byWreck = water.find((t) => Math.abs(t.q - HARBOR_WRECK.q) + Math.abs(t.r - HARBOR_WRECK.r) === 1 && !(t.q === HARBOR_WRECK.q && t.r === HARBOR_WRECK.r));
    if (byWreck) expect(waterSpotAt(map, byWreck)).toBe("wreck");
    expect(waterSpotAt(map, pier)).toBeNull();
    for (const t of water) expect(["coast_west", "coast_south", "coast_east", "wreck"]).toContain(waterSpotAt(map, t));
  });

  it("need the right boat for each spot", () => {
    expect(vesselProblem("west", null)).toBeNull();
    expect(vesselProblem("coast_west", null)).toMatch(/boat/);
    expect(vesselProblem("coast_west", "barrel")).toBeNull();
    expect(vesselProblem("sea", "barrel")).toMatch(/rowboat/);
    expect(vesselProblem("sea", "rowboat")).toBeNull();
  });

  it("brings the wreck grouper up more by the wreck", () => {
    const count = (bonus?: Record<string, number>) => {
      const rng = makeRng(9);
      let n = 0;
      for (let i = 0; i < 6000; i++) if (rollCatch(rng, "deep", 0.5, bonus).id === "wreck_grouper") n++;
      return n;
    };
    expect(count(FISH_SPOTS.wreck.bonus)).toBeGreaterThan(count() * 1.5);
  });

  it("fishes the open sea from a rowboat, and refuses a barrel", () => {
    const s = startSitting("west", 4, { str: 9, dex: 9 }, 0);
    expect(stepGather(s, { t: "cast", power: 0.5, spot: "sea", vessel: "barrel", now: 1 }).error).toMatch(/rowboat/);
    const at = stepGather(s, { t: "cast", power: 0.5, spot: "sea", vessel: "rowboat", now: 1 });
    expect(at.error).toBeUndefined();
    expect(FISH[at.state.sitting!.cast!.fish.species].water).toContain("sea");
    expect(gatherView(at.state).sitting!.spot).toBe("sea");
    expect(at.state.sitting!.vessel).toBe("rowboat");
  });

  it("will not be placed in a room", () => {
    expect(placeProblem(hutRoom(1), [], "rowboat", { q: 1, r: 1 })).toMatch(/pier/);
  });
});
