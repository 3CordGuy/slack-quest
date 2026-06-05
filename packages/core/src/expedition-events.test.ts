import { describe, expect, it } from "vitest";
import {
  ALL_EVENTS,
  sampleEvent,
  sampleOutcome,
  type ExpeditionEvent,
  type SamplerHistory,
} from "./expedition-events";

// Deterministic test RNG.
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

// mulberry32-based deterministic stream — used for "many trials" stats.
function prng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function emptyHistory(): SamplerHistory {
  return {
    expeditionResolvedIds: [],
    recentCharacterEventIds: [],
    longTailCharacterEventIds: [],
    recentExpeditionTags: [],
  };
}

describe("event pool basic shape", () => {
  it("Pass 1 ships at least 10 events covering all 4 setups", () => {
    expect(ALL_EVENTS.length).toBeGreaterThanOrEqual(10);
    const setups = new Set(ALL_EVENTS.map((e) => e.setup));
    expect(setups.has("encounter")).toBe(true);
    expect(setups.has("discovery")).toBe(true);
    expect(setups.has("dilemma")).toBe(true);
    expect(setups.has("npc")).toBe(true);
  });

  it("every event has 2-4 branches with 1-3 outcomes", () => {
    for (const e of ALL_EVENTS) {
      expect(e.branches.length).toBeGreaterThanOrEqual(2);
      expect(e.branches.length).toBeLessThanOrEqual(4);
      for (const b of e.branches) {
        expect(b.outcomes.length).toBeGreaterThanOrEqual(1);
        expect(b.outcomes.length).toBeLessThanOrEqual(3);
        const totalW = b.outcomes.reduce((acc, o) => acc + o.weight, 0);
        expect(totalW).toBeGreaterThan(0);
      }
    }
  });

  it("event ids are unique", () => {
    const ids = new Set(ALL_EVENTS.map((e) => e.id));
    expect(ids.size).toBe(ALL_EVENTS.length);
  });
});

describe("sampleEvent — no repeat within expedition", () => {
  it("excludes events already resolved in this expedition", () => {
    const inThisRun = ALL_EVENTS.slice(0, 5).map((e) => e.id);
    const hist: SamplerHistory = { ...emptyHistory(), expeditionResolvedIds: inThisRun };
    // Run many samples and verify none collide with the excluded set.
    for (let i = 0; i < 50; i++) {
      const picked = sampleEvent({ rng: seqRng([i / 50]), history: hist });
      expect(picked).not.toBeNull();
      expect(inThisRun).not.toContain(picked!.id);
    }
  });

  it("returns null when every event is hard-excluded", () => {
    const hist: SamplerHistory = {
      ...emptyHistory(),
      expeditionResolvedIds: ALL_EVENTS.map((e) => e.id),
    };
    expect(sampleEvent({ rng: () => 0.5, history: hist })).toBeNull();
  });
});

describe("sampleEvent — character recency exclusion (last 10)", () => {
  it("excludes the last-10 character events", () => {
    const recent = ALL_EVENTS.slice(0, 3).map((e) => e.id);
    const hist: SamplerHistory = { ...emptyHistory(), recentCharacterEventIds: recent };
    for (let i = 0; i < 50; i++) {
      const picked = sampleEvent({ rng: seqRng([i / 50]), history: hist });
      expect(picked).not.toBeNull();
      expect(recent).not.toContain(picked!.id);
    }
  });
  it("recency exclusion respects the 10-event cap (entries beyond 10 are ignored)", () => {
    // Pile a target into the >10 slots; it should still be eligible.
    const target = ALL_EVENTS[0];
    const filler = new Array(15).fill("nonexistent");
    filler[12] = target.id; // index 12 is beyond the cap → ignored
    const hist: SamplerHistory = { ...emptyHistory(), recentCharacterEventIds: filler };
    let saw = false;
    for (let i = 0; i < 200; i++) {
      const picked = sampleEvent({ rng: seqRng([i / 200]), history: hist });
      if (picked?.id === target.id) saw = true;
    }
    expect(saw).toBe(true);
  });
});

describe("sampleEvent — overuse penalty (3+ in last 50)", () => {
  it("an event seen 3+ times in last 50 is sampled less often than a clean one", () => {
    const overused = ALL_EVENTS[0];
    const fresh = ALL_EVENTS[1];
    // Build a long-tail history that has `overused` 3 times.
    const longTail = [overused.id, overused.id, overused.id];
    const hist: SamplerHistory = {
      ...emptyHistory(),
      longTailCharacterEventIds: longTail,
    };
    // Restrict the pool to those two events so we can measure cleanly.
    const pool = [overused, fresh];
    let overCount = 0;
    let freshCount = 0;
    const trials = 4000;
    const rng = prng(0xC0FFEE);
    for (let i = 0; i < trials; i++) {
      const picked = sampleEvent({ rng, history: hist, pool });
      if (picked?.id === overused.id) overCount++;
      else if (picked?.id === fresh.id) freshCount++;
    }
    // PENALTY_OVERUSED = 0.4 — fresh should be ~2.5x more likely.
    expect(freshCount).toBeGreaterThan(overCount);
  });
});

describe("sampleEvent — anti-monotony tag bias", () => {
  it("back-to-back grim+dilemma is biased *against* a matching follow-up", () => {
    const grimDilemma = ALL_EVENTS.find(
      (e) => e.tone === "grim" && e.setup === "dilemma",
    );
    const lightAlt = ALL_EVENTS.find(
      (e) => e.tone !== "grim" && e.setup !== "dilemma",
    );
    expect(grimDilemma).toBeTruthy();
    expect(lightAlt).toBeTruthy();
    const hist: SamplerHistory = {
      ...emptyHistory(),
      recentExpeditionTags: [
        {
          tone: "grim",
          setup: "dilemma",
          risk: grimDilemma!.risk,
          theme: grimDilemma!.theme,
        },
      ],
    };
    const pool = [grimDilemma!, lightAlt!];
    let grimCount = 0;
    let altCount = 0;
    const trials = 4000;
    const rng = prng(0xDEADBEEF);
    for (let i = 0; i < trials; i++) {
      const picked = sampleEvent({ rng, history: hist, pool });
      if (picked?.id === grimDilemma!.id) grimCount++;
      else if (picked?.id === lightAlt!.id) altCount++;
    }
    // Two soft penalties (tone match + setup match) stack multiplicatively.
    expect(altCount).toBeGreaterThan(grimCount);
  });
});

describe("sampleOutcome", () => {
  it("respects weights (60/30/10) over many trials", () => {
    const branch = {
      id: "test",
      label: "x",
      outcomes: [
        { weight: 60, text: "a" },
        { weight: 30, text: "b" },
        { weight: 10, text: "c" },
      ],
    };
    const counts = { a: 0, b: 0, c: 0 };
    const trials = 5000;
    const rng = prng(0x1234);
    for (let i = 0; i < trials; i++) {
      const o = sampleOutcome(rng, branch);
      counts[o.text as "a" | "b" | "c"]++;
    }
    expect(counts.a).toBeGreaterThan(counts.b);
    expect(counts.b).toBeGreaterThan(counts.c);
  });
});
