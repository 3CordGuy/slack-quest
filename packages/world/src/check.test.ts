import { describe, expect, it } from "vitest";
import { makeRng, rollCheck, statPct } from "./index";

describe("rng and rollCheck", () => {
  it("is deterministic and resumable from its state", () => {
    const a = makeRng(42);
    const first = [a.next(), a.next(), a.next()];
    const b = makeRng(42);
    b.next();
    const resumed = makeRng(b.state());
    expect([resumed.next(), resumed.next()]).toEqual(first.slice(1));
  });

  it("guarantees focus rolls and reports perfect / fumble", () => {
    const sure = rollCheck(makeRng(1), { label: "x", pct: 0, count: 3, focus: 2 });
    expect(sure.rolls).toEqual([true, true, false]);
    expect(sure.successes).toBe(2);
    expect(rollCheck(makeRng(1), { label: "x", pct: 100, count: 4 }).perfect).toBe(true);
    expect(rollCheck(makeRng(1), { label: "x", pct: 0, count: 4 }).fumble).toBe(true);
  });

  it("lands near the stated percentage", () => {
    const rng = makeRng(7);
    let hits = 0;
    for (let i = 0; i < 4000; i++) hits += rollCheck(rng, { label: "x", pct: 70, count: 1 }).successes;
    expect(hits / 4000).toBeGreaterThan(0.67);
    expect(hits / 4000).toBeLessThan(0.73);
  });

  it("maps stats to a clamped percentage", () => {
    expect(statPct(4)).toBe(42);
    expect(statPct(9)).toBe(57);
    expect(statPct(22)).toBe(95);
    expect(statPct(40)).toBe(95);
    expect(statPct(-5)).toBe(20);
  });
});
