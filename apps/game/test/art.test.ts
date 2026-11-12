// Admin art overrides as the renderers apply them: palettes laid over the
// stock looks field by field, and the marker colours in a custom icon that
// keep the rarity tint.

import { describe, expect, it } from "vitest";
import { MARKER_ACCENT, MARKER_SHADE, markerColour } from "../src/client/itemArt";
import { LOOKS, mergeLook } from "../src/client/render/looks";

describe("mergeLook", () => {
  const base = LOOKS.bandit;

  it("keeps the stock look when there is no palette", () => {
    expect(mergeLook(base, undefined)).toBe(base);
  });

  it("replaces only the fields given, and never touches the stock look", () => {
    const merged = mergeLook(base, { body: "#000000", hat: "wizard", weapon: "bow" });
    expect(merged).toEqual({ ...base, body: "#000000", hat: "wizard", weapon: "bow" });
    expect(LOOKS.bandit.body).toBe("#7a2f2f");
  });

  it("ignores anything a stored palette gets wrong", () => {
    const merged = mergeLook(base, { body: "red", hat: "crown", weapon: 3, skin: "#12345", coat: true, legs: "#AbCdEf" });
    expect(merged).toEqual({ ...base, legs: "#AbCdEf" });
  });
});

describe("markerColour", () => {
  it("draws the markers in the rarity colour and its shade", () => {
    expect(markerColour(255, 0, 255, "#3b82f6", "#2655a0")).toBe("#3b82f6");
    expect(markerColour(128, 0, 128, "#3b82f6", "#2655a0")).toBe("#2655a0");
    expect(MARKER_ACCENT).toBe("#ff00ff");
    expect(MARKER_SHADE).toBe("#800080");
  });

  it("draws every other colour as it is", () => {
    expect(markerColour(201, 209, 220, "#3b82f6", "#2655a0")).toBe("#c9d1dc");
    expect(markerColour(254, 0, 255, "#3b82f6", "#2655a0")).toBe("#fe00ff");
  });
});
