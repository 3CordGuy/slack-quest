import { describe, expect, it } from "vitest";
import { DEFAULT_APPEARANCE, INK_COLORS, INK_LEVELS, INK_REGIONS, MAX_INK_CELLS, appearanceKey, decodeInk, encodeInk, inkCell, parseAppearance, parseInk } from "./appearance";

describe("ink", () => {
  it("round-trips cells through its encoding", () => {
    const cells = new Map([[0, inkCell(1, 5)], [37, inkCell(INK_COLORS.length, 1)], [783, inkCell(4, 3)]]);
    expect(decodeInk(encodeInk(cells))).toEqual(cells);
  });

  it("keeps only known sides, cells in their grid and known shades", () => {
    const { cols, rows } = INK_REGIONS.armL;
    const inGrid = encodeInk(new Map([[5, inkCell(2, 4)]]));
    const outOfGrid = (cols * rows).toString(36).padStart(2, "0") + "15";
    const badColor = "06z5";
    const badLevel = "071" + (INK_LEVELS + 1);
    const ink = parseInk({ "armL.f": inGrid + outOfGrid + badColor + badLevel, "tail.f": inGrid, "head.b": 7 });
    expect(ink).toEqual({ "armL.f": inGrid });
  });

  it("is undefined when nothing is inked", () => {
    expect(parseInk({ "head.f": "" })).toBeUndefined();
    expect(parseInk("nonsense")).toBeUndefined();
  });

  it("caps how much can be inked", () => {
    const all = new Map(Array.from({ length: 784 }, (_, i) => [i, inkCell(1, 5)] as [number, number]));
    const full = encodeInk(all);
    const ink = parseInk({ "head.f": full, "head.b": full, "armL.f": full })!;
    const total = Object.values(ink).reduce((n, v) => n + decodeInk(v).size, 0);
    expect(total).toBe(MAX_INK_CELLS);
  });

  it("travels with the appearance, and changes its key", () => {
    const look = parseAppearance({ ...DEFAULT_APPEARANCE, ink: { "head.f": "0a15" } })!;
    expect(look.ink).toEqual({ "head.f": "0a15" });
    expect(appearanceKey(look)).not.toBe(appearanceKey(DEFAULT_APPEARANCE));
    expect(parseAppearance(DEFAULT_APPEARANCE)!.ink).toBeUndefined();
  });

  it("reads facial hair saved as one choice as the mustache and beard it drew", () => {
    const { facialHair: _, ...rest } = { ...DEFAULT_APPEARANCE, facialHair: "goatee" };
    void _;
    const look = parseAppearance({ ...rest, facialHair: "goatee", mustache: undefined, beard: undefined })!;
    expect([look.mustache, look.beard]).toEqual(["bushy", "goatee"]);
    expect(parseAppearance({ ...DEFAULT_APPEARANCE, mustache: "walrus", beard: "none" })!.mustache).toBe("walrus");
  });
});
