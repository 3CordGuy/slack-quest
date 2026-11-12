// Harbor XP: what each pastime pays, the daily cap, and level-ups.

import { describe, expect, it } from "vitest";
import { FREE_POINTS_PER_LEVEL, STARTING_STATS } from "@gantt-quest/core";
import {
  GATHER_MAX_UNITS,
  HARBOR_XP,
  HARBOR_XP_DAILY_CAP,
  SPAR_XP_DAILY_BOUTS,
  gatherDay,
  gatherXp,
  harborXpAward,
  harborXpLeft,
  harborXpStatus,
  harborXpText,
  sparBoutsLeft,
  xpToNext,
  type HarborXpRecord,
  type Progress,
} from "./index";

const NOON = Date.UTC(2026, 10, 12, 12);
const TOMORROW = NOON + 86_400_000;
const hero = (over: Partial<Progress> = {}): Progress => ({ classId: "qa_paladin", level: 1, xp: 0, stats: { ...STARTING_STATS.qa_paladin }, unspent: 0, ...over });

describe("what the pastimes pay", () => {
  it("stays small: every pastime pays 2 to 10 XP", () => {
    for (const n of Object.values(HARBOR_XP)) {
      expect(n).toBeGreaterThanOrEqual(2);
      expect(n).toBeLessThanOrEqual(10);
    }
  });

  it("pays a lost haul a little, a banked one more, and a good haul most", () => {
    expect(gatherXp({ status: "bust", haul: {} }, 0)).toBe(HARBOR_XP.gatherBust);
    expect(gatherXp({ status: "banked", haul: {} }, 1)).toBe(HARBOR_XP.gatherBanked);
    expect(gatherXp({ status: "banked", haul: {} }, 4)).toBe(HARBOR_XP.gatherBanked + 2);
    expect(gatherXp({ status: "banked", haul: {} }, GATHER_MAX_UNITS)).toBe(HARBOR_XP.gatherBanked + 4);
    expect(gatherXp({ status: "banked", haul: {} }, 99)).toBeLessThanOrEqual(10);
    expect(gatherXp({ status: "bust", haul: {} }, 0)).toBeLessThan(gatherXp({ status: "banked", haul: {} }, 1));
  });

  it("pays nothing for an outing still under way", () => {
    expect(gatherXp({ status: "active", haul: {} }, 3)).toBe(0);
  });

  it("caps a day at a fraction of one won voyage (150 to 200 XP)", () => {
    expect(HARBOR_XP_DAILY_CAP).toBeLessThanOrEqual(40);
  });
});

describe("the daily cap", () => {
  it("starts each UTC day full", () => {
    expect(harborXpLeft(null, NOON)).toBe(HARBOR_XP_DAILY_CAP);
    expect(harborXpLeft({ day: gatherDay(NOON), used: 12 }, NOON)).toBe(HARBOR_XP_DAILY_CAP - 12);
    // Yesterday's record counts for nothing today.
    expect(harborXpLeft({ day: gatherDay(NOON), used: HARBOR_XP_DAILY_CAP }, TOMORROW)).toBe(HARBOR_XP_DAILY_CAP);
    expect(harborXpStatus(null, NOON)).toEqual({ left: HARBOR_XP_DAILY_CAP, cap: HARBOR_XP_DAILY_CAP, resetsAt: Date.UTC(2026, 10, 13) });
  });

  it("gives the whole amount while there is room", () => {
    const a = harborXpAward(hero(), null, 5, NOON);
    expect(a.granted).toBe(5);
    expect(a.record).toEqual({ day: gatherDay(NOON), used: 5, spars: 0 });
    expect(a.next.xp).toBe(5);
  });

  it("cuts the last award down to what is left, then gives nothing", () => {
    let record: HarborXpRecord | null = null;
    let total = 0;
    for (let i = 0; i < 20; i++) {
      const a = harborXpAward(hero(), record, 7, NOON);
      total += a.granted;
      record = a.record;
    }
    expect(total).toBe(HARBOR_XP_DAILY_CAP);
    expect(record!.used).toBe(HARBOR_XP_DAILY_CAP);
    const last = harborXpAward(hero(), record, 7, NOON);
    expect(last.granted).toBe(0);
    expect(last.next.xp).toBe(0);
    expect(harborXpText({ granted: last.granted, asked: last.asked })).toMatch(/daily Harbor XP reached/);
  });

  it("opens again the next day", () => {
    const full: HarborXpRecord = { day: gatherDay(NOON), used: HARBOR_XP_DAILY_CAP, spars: SPAR_XP_DAILY_BOUTS };
    const a = harborXpAward(hero(), full, 4, TOMORROW);
    expect(a.granted).toBe(4);
    expect(a.record).toEqual({ day: gatherDay(TOMORROW), used: 4, spars: 0 });
  });

  it("ignores nonsense amounts", () => {
    expect(harborXpAward(hero(), null, -5, NOON).granted).toBe(0);
    expect(harborXpAward(hero(), null, Number.NaN, NOON).granted).toBe(0);
    expect(harborXpAward(hero(), null, 3.9, NOON).granted).toBe(3);
  });
});

describe("sparring", () => {
  it("counts only the first few bouts a day", () => {
    let record: HarborXpRecord | null = null;
    const paid: number[] = [];
    for (let i = 0; i < SPAR_XP_DAILY_BOUTS + 2; i++) {
      const a = harborXpAward(hero(), record, HARBOR_XP.spar, NOON, true);
      paid.push(a.granted);
      record = a.record;
    }
    expect(paid.slice(0, SPAR_XP_DAILY_BOUTS).every((n) => n === HARBOR_XP.spar)).toBe(true);
    expect(paid.slice(SPAR_XP_DAILY_BOUTS)).toEqual([0, 0]);
    expect(sparBoutsLeft(record, NOON)).toBe(0);
    expect(sparBoutsLeft(record, TOMORROW)).toBe(SPAR_XP_DAILY_BOUTS);
  });

  it("does not use up the spar allowance with other pastimes", () => {
    const a = harborXpAward(hero(), null, HARBOR_XP.craft, NOON);
    expect(a.record.spars).toBe(0);
  });
});

describe("levelling from Harbor XP", () => {
  it("levels up with stat points, as a voyage would", () => {
    const near = hero({ xp: xpToNext(1) - 2 });
    const a = harborXpAward(near, null, 5, NOON);
    expect(a.granted).toBe(5);
    expect(a.next.level).toBe(2);
    expect(a.next.levelsGained).toBe(1);
    expect(a.next.xp).toBe(3);
    expect(a.next.unspent).toBe(FREE_POINTS_PER_LEVEL);
    // The class's own level-up stats go up too.
    expect(a.next.stats.str).toBe(STARTING_STATS.qa_paladin.str + 1);
    expect(harborXpText({ granted: a.granted, asked: a.asked, levelsGained: a.next.levelsGained })).toBe("+5 XP. Level up!");
  });

  it("does not level up without enough XP", () => {
    const a = harborXpAward(hero({ xp: 10 }), null, 5, NOON);
    expect(a.next.level).toBe(1);
    expect(a.next.unspent).toBe(0);
  });
});

describe("the result line", () => {
  it("reads plainly", () => {
    expect(harborXpText({ granted: 4, asked: 4 })).toBe("+4 XP.");
    expect(harborXpText({ granted: 2, asked: 5 })).toBe("+2 XP (daily Harbor XP reached).");
    expect(harborXpText({ granted: 0, asked: 0 })).toBe("");
  });
});
