// The enemy tables: bears, ogres and trolls as data, and how many of each
// kind a band brings for a party of a given size. How they fight on the
// tiles is in zone/zone.test.ts.

import { describe, expect, it } from "vitest";
import { ENEMIES, LURKERS, TROLL_REGEN, bandKinds } from "./index";

describe("the bear", () => {
  it("is a slow, tough bruiser that hits harder than a wolf and tears rather than clubs", () => {
    const { bear, wolf, brute } = ENEMIES;
    expect(bear.boss).toBeFalsy();
    expect(bear.hp).toBeGreaterThan(brute.hp);
    expect(bear.hp).toBeGreaterThan(wolf.hp * 2);
    expect(bear.speed).toBeLessThan(wolf.speed);
    expect(bear.speed).toBeLessThanOrEqual(brute.speed);
    const hardest = Math.max(...bear.attacks.map((a) => a.damage));
    expect(hardest).toBeGreaterThan(Math.max(...wolf.attacks.map((a) => a.damage)));
    // Its heavy blow makes them bleed; only its roar stuns.
    const swipe = bear.attacks.find((a) => a.damage === hardest)!;
    expect(swipe.perfect?.effect).toBe("bleeding");
    expect(bear.attacks.some((a) => a.name === "Roar" && a.perfect?.effect === "stunned")).toBe(true);
  });

  it("has a boss of its own: bigger, and its roar shakes the whole party", () => {
    const big = ENEMIES.great_bear;
    expect(big.boss).toBe(true);
    expect(big.hp).toBeGreaterThan(ENEMIES.bear.hp);
    expect(big.speed).toBeLessThan(ENEMIES.alpha.speed);
    expect(big.attacks.some((a) => a.target === "all_heroes" && a.perfect?.effect === "stunned")).toBe(true);
  });

  it("roams alone, or as a pair for a full party", () => {
    expect(bandKinds("bear", 1)).toEqual(["bear"]);
    expect(bandKinds("bear", 3)).toEqual(["bear"]);
    expect(bandKinds("bear", 4)).toEqual(["bear", "bear"]);
    // The other bands are sized as they always were.
    expect(bandKinds("wolf", 2)).toEqual(["wolf", "wolf"]);
    expect(bandKinds("bandit", 4)).toEqual(["bandit", "archer", "bandit"]);
  });
});

describe("the ogre", () => {
  it("is the slowest, toughest rank-and-file there is, and its club hits hardest", () => {
    const { ogre, bear, brute } = ENEMIES;
    expect(ogre.boss).toBeFalsy();
    expect(ogre.hp).toBeGreaterThan(bear.hp);
    expect(ogre.speed).toBeLessThan(bear.speed);
    const rank = Object.values(ENEMIES).filter((e) => !e.boss && e.kind !== "dummy");
    expect(Math.max(...ogre.attacks.map((a) => a.damage))).toBe(Math.max(...rank.flatMap((e) => e.attacks.map((a) => a.damage))));
    expect(ogre.attacks.find((a) => a.name === "Club Smash")?.perfect?.effect).toBe("stunned");
    // Its stomp reaches the whole party, and leaves them slow.
    expect(ogre.attacks.some((a) => a.target === "all_heroes" && a.perfect?.effect === "slowed")).toBe(true);
    expect(ogre.xp).toBeGreaterThan(brute.xp);
  });

  it("roams alone, with its keeper for a full party", () => {
    expect(bandKinds("ogre", 1)).toEqual(["ogre"]);
    expect(bandKinds("ogre", 3)).toEqual(["ogre"]);
    expect(bandKinds("ogre", 4)).toEqual(["ogre", "bandit"]);
  });
});

describe("the troll", () => {
  it("regenerates, and fire stops it", () => {
    expect(ENEMIES.troll.regen).toEqual({ amount: TROLL_REGEN, unless: "burning", name: "Regenerate" });
  });

  it("keeps a cave chamber to itself", () => {
    expect(LURKERS).toContainEqual(["troll"]);
  });
});

describe("the training dummy", () => {
  it("is feeble: worth nothing, never a boss, and tougher than anything in the ranks", () => {
    const dummy = ENEMIES.dummy;
    expect(dummy.xp).toBe(0);
    expect(dummy.boss).toBeFalsy();
    const softest = Math.min(...Object.values(ENEMIES).filter((e) => e.kind !== "dummy").flatMap((e) => e.attacks.map((a) => a.damage)));
    for (const a of dummy.attacks) expect(a.damage).toBeLessThan(softest);
    expect(dummy.hp).toBeGreaterThan(Math.max(...Object.values(ENEMIES).filter((e) => !e.boss && e.kind !== "dummy").map((e) => e.hp)));
  });
});
