// The combat view (render/cutaway.ts): when it is on, and what it takes to be standing in the way.

import { beforeEach, describe, expect, it } from "vitest";
import * as THREE from "three";
import { CombatView, sunkY } from "../src/client/render/cutaway";

/** A session's storage, as a browser tab has it: emptied before each test. */
const kept = new Map<string, string>();
beforeEach(() => {
  kept.clear();
  (globalThis as { sessionStorage?: unknown }).sessionStorage = {
    getItem: (k: string) => kept.get(k) ?? null,
    setItem: (k: string, v: string) => void kept.set(k, v),
    removeItem: (k: string) => void kept.delete(k),
  };
});

describe("the combat view", () => {
  it("is not there until a battle map says whether a fight is on", () => {
    const view = new CombatView();
    expect(view.enabled).toBe(false);
    view.toggle();
    expect(view.on).toBe(false);
    view.setFight(false, "A");
    expect(view.enabled).toBe(true);
    expect(view.on).toBe(false);
  });

  it("comes on when a fight starts and goes off when it ends", () => {
    const view = new CombatView();
    view.setFight(false, "A");
    view.setFight(true, "A");
    expect(view.on).toBe(true);
    view.setFight(false, "A");
    expect(view.on).toBe(false);
  });

  it("switched off in a fight, stays off until the next fight", () => {
    const view = new CombatView();
    view.setFight(false, "A");
    view.setFight(true, "A");
    view.toggle();
    expect(view.on).toBe(false);
    // The same fight, told again: nothing changes.
    view.setFight(true, "A");
    expect(view.on).toBe(false);
    view.setFight(false, "A");
    expect(view.on).toBe(false);
    view.setFight(true, "A");
    expect(view.on).toBe(true);
  });

  it("is as it was left when the map is opened again in the middle of the same fight", () => {
    const view = new CombatView();
    view.setFight(false, "A");
    view.setFight(true, "A");
    view.toggle();
    const again = new CombatView();
    again.setFight(true, "A");
    expect(again.on).toBe(false);
    // Another map's fight is another fight.
    const elsewhere = new CombatView();
    elsewhere.setFight(true, "B");
    expect(elsewhere.on).toBe(true);
  });

  it("keeps the choice made while walking about, and goes back to it after a fight", () => {
    const view = new CombatView();
    view.setFight(false, "A");
    view.toggle();
    expect(view.on).toBe(true);
    view.setFight(true, "A");
    view.setFight(false, "A");
    expect(view.on).toBe(true);
    const later = new CombatView();
    later.setFight(false, "B");
    expect(later.on).toBe(true);
    later.toggle();
    view.setFight(true, "A");
    view.setFight(false, "A");
    expect(view.on).toBe(false);
  });

  it("sinks what stands between the eye and a fighter, and leaves what stands beyond them", () => {
    const view = new CombatView();
    view.setFight(true, "A");
    // The eye to the south and above, a fighter in the middle of the map.
    const eye = new THREE.Vector3(0, 20, 20);
    view.frame(1, eye, [{ id: "fighter", x: 0, y: 0, z: 0, r: 2 }]);
    expect(view.shown).toBe(1);
    // A wall's top, 2.2 up: a few hexes toward the eye it comes down to a kerb; as far beyond the fighter it stands.
    expect(sunkY(2.2, 0, 0, 3)).toBeCloseTo(0.585, 3);
    expect(sunkY(2.2, 0, 0, -6)).toBe(2.2);
    // Well off to one side it hides nobody.
    expect(sunkY(2.2, 0, 9, 3)).toBe(2.2);
    // What is under the kerb's height never moves.
    expect(sunkY(0.4, 0, 0, 3)).toBe(0.4);
    // Once the view has drawn, nothing is sunk for whatever draws next.
    view.clear();
    expect(sunkY(2.2, 0, 0, 3)).toBe(2.2);
  });

  it("eases off, and is gone", () => {
    const view = new CombatView();
    view.setFight(true, "A");
    const eye = new THREE.Vector3(0, 20, 20);
    view.frame(1, eye, []);
    view.toggle();
    view.frame(0.1, eye, []);
    expect(view.shown).toBeGreaterThan(0);
    expect(view.shown).toBeLessThan(1);
    view.frame(1, eye, []);
    expect(view.shown).toBe(0);
  });
});
