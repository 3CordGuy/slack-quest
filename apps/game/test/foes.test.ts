// How the battle cards name who the crew fought.

import { describe, expect, it } from "vitest";

// api.ts reads the page's query string when it loads.
(globalThis as { location?: unknown }).location = { search: "" };
const { foeNames, sentenceCase } = await import("../src/client/foes");

describe("foeNames", () => {
  it("names a boss by the name the story gave it, and whoever is with it", () => {
    expect(foeNames([{ kind: "great_bear", name: "the Sleepless Sow" }])).toBe("the Sleepless Sow");
    expect(foeNames([{ kind: "villain", name: "Maud the Wrecker" }, { kind: "brute", name: "Brute" }])).toBe("Maud the Wrecker, Brute");
  });

  it("counts up rank-and-file by kind", () => {
    expect(foeNames([{ kind: "wolf", name: "Dire Wolf" }, { kind: "wolf", name: "Dire Wolf" }, { kind: "bandit", name: "Bandit" }])).toBe("2 × Dire Wolf, Bandit");
    expect(foeNames([{ kind: "bear", name: "Cave Bear" }])).toBe("Cave Bear");
  });

  it("opens a sentence with a capital", () => {
    expect(sentenceCase("the Sleepless Sow")).toBe("The Sleepless Sow");
    expect(sentenceCase("2 × Dire Wolf")).toBe("2 × Dire Wolf");
  });
});
