import { describe, expect, it } from "vitest";
import { cleanHeroName } from "../src/server/ai";

describe("cleanHeroName", () => {
  it("keeps short names made of letters, spaces, hyphens and apostrophes", () => {
    expect(cleanHeroName("Marlow Brine")).toBe("Marlow Brine");
    expect(cleanHeroName("  Nell   O'Shoals ")).toBe("Nell O'Shoals");
    expect(cleanHeroName("Wren Salt-Wake")).toBe("Wren Salt-Wake");
    expect(cleanHeroName("\"Isla.\"")).toBe("Isla");
  });
  it("rejects anything that would not pass character creation", () => {
    expect(cleanHeroName("A")).toBeNull();
    expect(cleanHeroName("Barnaby Quartermaster-Longfellow")).toBeNull();
    expect(cleanHeroName("Name: <script>")).toBeNull();
    expect(cleanHeroName("R2D2")).toBeNull();
    expect(cleanHeroName(42)).toBeNull();
  });
});
