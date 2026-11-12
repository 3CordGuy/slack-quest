// Display names with admin overrides applied, and items keeping their rarity
// word when their base is renamed.

import { beforeAll, describe, expect, it } from "vitest";

// api.ts reads the page's query string when it loads.
(globalThis as { location?: unknown }).location = { search: "" };
const { setContent } = await import("../src/client/content");
const { blurb, costLabel, itemName, label } = await import("../src/client/labels");

beforeAll(() => {
  setContent({
    version: 1,
    names: {
      "class:qa_paladin": { name: "Test Paladin" },
      "weapon:mace": { name: "Bug Mace" },
      "gear:hauberk": { blurb: "only the blurb" },
      "resource:wood": { name: "Timber" },
    },
    palettes: {},
    icons: {},
    sprites: {},
  });
});

describe("labels", () => {
  it("uses the override, then the code default, then the id", () => {
    expect(label("class", "qa_paladin")).toBe("Test Paladin");
    expect(label("class", "devops_mage")).toBe("DevOps Mage");
    expect(label("class", "nobody")).toBe("nobody");
    expect(blurb("class", "qa_paladin")).toMatch(/front-liner/);
    expect(costLabel("wood")).toBe("Timber");
    expect(costLabel("gold")).toBe("Gold");
  });

  it("rebuilds an owned item's name from its rarity and renamed base", () => {
    expect(itemName({ kind: "weapon", ref: "mace", rarity: "rare", name: "Fine Audit Mace" })).toBe("Fine Bug Mace");
    expect(itemName({ kind: "weapon", ref: "mace", rarity: "common", name: "Audit Mace" })).toBe("Bug Mace");
    // Not renamed (only its blurb changed), or not overridden at all: the stored name stands.
    expect(itemName({ kind: "armor", ref: "hauberk", rarity: "epic", name: "Masterwork Hauberk of Uptime" })).toBe("Masterwork Hauberk of Uptime");
    expect(itemName({ kind: "weapon", ref: "staff", rarity: "rare", name: "Fine Pipeline Staff" })).toBe("Fine Pipeline Staff");
  });
});
