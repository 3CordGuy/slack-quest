// The fight's bar: two rows of ten, how it starts out, and a bar saved when a row was nine.

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { BAR_ROW, BAR_SLOTS, COMMON_ORDER, ITEM_ORDER, defaultBar, loadBar } from "../src/client/zone/hotbar";
import { RACK } from "../src/client/ui/rackArt";

const store = new Map<string, string>();
beforeEach(() => {
  store.clear();
  (globalThis as { localStorage?: unknown }).localStorage = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => store.set(k, v) };
});
afterEach(() => {
  delete (globalThis as { localStorage?: unknown }).localStorage;
});

const paladin = ["bash", "block", "cleave", "beacon_aura", "healing_aura", "branding_strike"];

describe("the fight's bar", () => {
  it("is two rows of ten, and the rack has a well for every slot in a row", () => {
    expect(BAR_ROW).toBe(10);
    expect(BAR_SLOTS).toBe(20);
    expect(RACK.mid).toHaveLength(BAR_ROW);
    // The bag sits right of the second post, which sits right of the last slot.
    expect(RACK.posts[1]).toBeGreaterThan(RACK.mid[BAR_ROW - 1] + RACK.slot);
    expect(RACK.bag).toBeGreaterThan(RACK.posts[1]);
    expect(RACK.tabs.right).toBeGreaterThan(RACK.bag + RACK.slot);
  });

  it("starts out with everything a Paladin with three weapon and three class abilities has: twenty things, twenty slots", () => {
    const bar = defaultBar(paladin);
    expect(bar).toHaveLength(BAR_SLOTS);
    const want = [...paladin.map((a) => `ab:${a}`), ...COMMON_ORDER.map((c) => `do:${c}`), ...ITEM_ORDER.map((i) => `it:${i}`)];
    expect(want).toHaveLength(BAR_SLOTS);
    expect(new Set(bar)).toEqual(new Set(want));
    // Abilities lead the top row; Flee ends the bottom one.
    expect(bar.slice(0, paladin.length)).toEqual(paladin.map((a) => `ab:${a}`));
    expect(bar[BAR_SLOTS - 1]).toBe("do:flee");
  });

  it("keeps a bar saved when a row was nine, with the new slot on the end of each row given to what has no place", () => {
    const old = [
      "ab:bash", "ab:block", "do:dash", "do:disengage", "do:jump", "do:shove", "do:help", "", "",
      "it:healing", "it:poison", "it:fire", "it:oil", "it:water", "it:acid", "it:slime", "it:torch", "do:flee",
    ];
    store.set("gq.zone.bar.qa_paladin", JSON.stringify(old));
    const bar = loadBar("qa_paladin", ["bash", "block", "beacon_aura", "healing_aura", "branding_strike"]);
    expect(bar).toHaveLength(BAR_SLOTS);
    // Where things were, they still are.
    expect(bar.slice(0, 7)).toEqual(old.slice(0, 7));
    expect(bar.slice(BAR_ROW, BAR_ROW + 9)).toEqual(old.slice(9));
    // And all three class abilities found a slot.
    for (const a of ["beacon_aura", "healing_aura", "branding_strike"]) expect(bar).toContain(`ab:${a}`);
  });
});
