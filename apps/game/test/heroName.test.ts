import { describe, expect, it } from "vitest";
import { cleanHeroName, heroName } from "../src/server/ai";
import type { Env } from "../src/server/db";

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

describe("heroName (stock generator)", () => {
  const env = { AI_MODE: "mock" } as unknown as Env;
  const input = { className: "Tidewall Paladin", blurb: "Tough front-liner." };

  it("gives a harbor first name and a two-part sea surname that passes the filter", async () => {
    for (let i = 0; i < 50; i++) {
      const name = await heroName(env, { ...input, avoid: [], isTaken: async () => false });
      expect(cleanHeroName(name)).toBe(name);
      expect(name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
    }
  });

  it("never suggests a name another player has, or one already offered", async () => {
    const taken = new Set<string>();
    const offered: string[] = [];
    for (let i = 0; i < 30; i++) {
      const name = await heroName(env, { ...input, avoid: offered, isTaken: async (n) => taken.has(n.toLowerCase()) });
      expect(taken.has(name.toLowerCase())).toBe(false);
      expect(offered).not.toContain(name);
      taken.add(name.toLowerCase());
      offered.push(name);
    }
  });
});
