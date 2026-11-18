// Ogres and trolls. The ogre is the heaviest thing that walks ashore: it roams
// and holds camps. The troll grows back every turn unless it is Burning: it
// holds island camps and lies up alone in a cave chamber.

import { describe, expect, it } from "vitest";
import {
  ENEMIES,
  ENEMY_DROPS,
  LURKERS,
  ROAMER_LEADS,
  TROLL_REGEN,
  bandKinds,
  battleDrops,
  makeRng,
} from "./index";
import { CAVE_SIM_ENCOUNTERS, SIM_ENCOUNTERS } from "./balance";

describe("the ogre", () => {
  it("is the slowest, toughest rank-and-file there is, and its club hits hardest", () => {
    const { ogre, bear, brute } = ENEMIES;
    expect(ogre.boss).toBeFalsy();
    expect(ogre.hp).toBeGreaterThan(bear.hp);
    expect(ogre.speed).toBeLessThan(bear.speed);
    const rank = Object.values(ENEMIES).filter((e) => !e.boss && e.kind !== "dummy");
    expect(Math.max(...ogre.attacks.map((a) => a.damage))).toBe(Math.max(...rank.flatMap((e) => e.attacks.map((a) => a.damage))));
    expect(ogre.attacks.find((a) => a.name === "Club Smash")?.perfect?.effect).toBe("stunned");
    // Its stomp reaches the whole crew, and leaves them slow.
    expect(ogre.attacks.some((a) => a.target === "all_heroes" && a.perfect?.effect === "slowed")).toBe(true);
    expect(ogre.xp).toBeGreaterThan(brute.xp);
  });

  it("roams ashore alone, with its keeper for a full ship", () => {
    expect(ROAMER_LEADS).toContain("ogre");
    expect(bandKinds("ogre", 1)).toEqual(["ogre"]);
    expect(bandKinds("ogre", 3)).toEqual(["ogre"]);
    expect(bandKinds("ogre", 4)).toEqual(["ogre", "bandit"]);
    expect(SIM_ENCOUNTERS.map((e) => e.id)).toEqual(expect.arrayContaining(["band:ogre", "camp:ogre"]));
  });

  it("leaves hide, bone and iron", () => {
    for (let seed = 1; seed <= 50; seed++) for (const k of Object.keys(battleDrops(makeRng(seed), ["ogre"]))) expect(ENEMY_DROPS.ogre).toContain(k);
    expect(ENEMY_DROPS.ogre).toEqual(["fur", "bone", "iron"]);
  });
});

describe("the troll", () => {
  it("regenerates, and fire stops it", () => {
    expect(ENEMIES.troll.regen).toEqual({ amount: TROLL_REGEN, unless: "burning", name: "Regenerate" });
  });

  it("holds island camps and keeps a cave chamber to itself", () => {
    expect(LURKERS).toContainEqual(["troll"]);
    expect(SIM_ENCOUNTERS.map((e) => e.id)).toContain("camp:troll");
    expect(CAVE_SIM_ENCOUNTERS.map((e) => e.id)).toContain("camp:troll");
    expect(ENEMY_DROPS.troll).toEqual(["bone", "stone"]);
  });
});
