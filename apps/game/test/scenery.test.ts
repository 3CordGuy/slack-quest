// What stands on a map's hexes is named by the rules (packages/world/src/zone/props.ts) and drawn by the client
// (render/zoneScenery.ts). A kind the rules know and the client cannot draw would be a hex that bars the way
// with nothing to be seen on it.

import { describe, expect, it } from "vitest";
import { PROP_KINDS, SITES, SITE_IDS } from "@gantt-quest/world";
import { SCENERY_KINDS } from "../src/client/render/zoneScenery";

describe("a map's scenery", () => {
  it("has a drawing for every kind of thing the rules can stand on a hex", () => {
    for (const kind of PROP_KINDS) expect(SCENERY_KINDS, kind).toContain(kind);
  });

  it("is strewn only with things the rules know", () => {
    for (const site of SITE_IDS) for (const kind of SITES[site].scatter) expect(PROP_KINDS, `${site}: ${kind}`).toContain(kind);
  });
});
