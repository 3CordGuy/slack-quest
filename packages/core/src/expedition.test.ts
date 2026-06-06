import { describe, expect, it } from "vitest";
import {
  availablePicks,
  countKinds,
  expeditionSeed,
  generateExpeditionMap,
  laneCountForParty,
  nodeById,
  outgoingEdges,
  reduceExpedition,
  type ExpeditionMap,
  type ExpeditionState,
} from "./expedition";

// ---------------- helpers ----------------

function makeMap(seed: string, partySize = 1, depth = 13) {
  return generateExpeditionMap({ seed, partySize, depth });
}

function laneOf(nodeId: string): number {
  if (nodeId === "start" || nodeId === "boss") return -1;
  const m = /^n_(\d+)_(\d+)$/.exec(nodeId);
  return m ? parseInt(m[2], 10) : -1;
}

function depthOf(nodeId: string): number {
  const m = /^n_(\d+)_(\d+)$/.exec(nodeId);
  return m ? parseInt(m[1], 10) : -1;
}

function crosses(a: { from: string; to: string }, b: { from: string; to: string }): boolean {
  // Two edges between the same depth pair cross iff their (fromLane, toLane)
  // pairs are out-of-order.
  if (depthOf(a.from) !== depthOf(b.from)) return false;
  if (depthOf(a.to) !== depthOf(b.to)) return false;
  if (a.from === "start" || a.to === "boss" || b.from === "start" || b.to === "boss") return false;
  const aF = laneOf(a.from), aT = laneOf(a.to);
  const bF = laneOf(b.from), bT = laneOf(b.to);
  if (aF === bF || aT === bT) return false;
  return (aF < bF && aT > bT) || (aF > bF && aT < bT);
}

// ---------------- determinism ----------------

describe("generateExpeditionMap — determinism", () => {
  it("same seed produces identical map", () => {
    const a = makeMap("seed-abc", 2);
    const b = makeMap("seed-abc", 2);
    expect(JSON.stringify(a)).toEqual(JSON.stringify(b));
  });

  it("different seed produces different map (high probability)", () => {
    const a = makeMap("alpha", 2);
    const b = makeMap("beta", 2);
    expect(JSON.stringify(a)).not.toEqual(JSON.stringify(b));
  });

  it("expeditionSeed sorts party ids so order doesn't matter", () => {
    const s1 = expeditionSeed(42, ["U1", "U2", "U3"]);
    const s2 = expeditionSeed(42, ["U3", "U1", "U2"]);
    expect(s1).toEqual(s2);
  });
});

// ---------------- lane count ----------------

describe("laneCountForParty", () => {
  it("solo gets 3 lanes", () => {
    expect(laneCountForParty(1)).toBe(3);
    expect(makeMap("s", 1).laneCount).toBe(3);
  });
  it("2+ players get 4 lanes", () => {
    expect(laneCountForParty(2)).toBe(4);
    expect(laneCountForParty(5)).toBe(4);
    expect(makeMap("s", 2).laneCount).toBe(4);
  });
});

// ---------------- hard rules ----------------

describe("generateExpeditionMap — hard rules", () => {
  const seeds = Array.from({ length: 25 }, (_, i) => `rules-${i}`);

  it("single start and single boss", () => {
    for (const s of seeds) {
      const map = makeMap(s, 2);
      const starts = map.nodes.filter((n) => n.kind === "start");
      const bosses = map.nodes.filter((n) => n.kind === "boss");
      expect(starts.length).toBe(1);
      expect(bosses.length).toBe(1);
    }
  });

  it("depth 0 nodes are all combat", () => {
    for (const s of seeds) {
      const map = makeMap(s, 2);
      const d0 = map.nodes.filter((n) => n.depth === 0);
      expect(d0.length).toBeGreaterThan(0);
      for (const n of d0) expect(n.kind).toBe("combat");
    }
  });

  it("depth (D-1) nodes are all camp", () => {
    for (const s of seeds) {
      const map = makeMap(s, 2);
      const last = map.depth - 1;
      const dn = map.nodes.filter((n) => n.depth === last);
      expect(dn.length).toBeGreaterThan(0);
      for (const n of dn) expect(n.kind).toBe("camp");
    }
  });

  it("no two elite adjacent on the same lane", () => {
    for (const s of seeds) {
      const map = makeMap(s, 2);
      // Build (lane -> sorted nodes by depth)
      const byLane = new Map<number, { depth: number; kind: string }[]>();
      for (const n of map.nodes) {
        if (n.kind === "start" || n.kind === "boss") continue;
        if (!byLane.has(n.lane)) byLane.set(n.lane, []);
        byLane.get(n.lane)!.push({ depth: n.depth, kind: n.kind });
      }
      for (const list of byLane.values()) {
        list.sort((a, b) => a.depth - b.depth);
        for (let i = 1; i < list.length; i++) {
          if (list[i].depth === list[i - 1].depth + 1) {
            const both = list[i].kind === "elite" && list[i - 1].kind === "elite";
            expect(both).toBe(false);
          }
        }
      }
    }
  });

  it("every depth-0 lane has a shrine reachable", () => {
    for (const s of seeds) {
      const map = makeMap(s, 2);
      const outgoing = new Map<string, string[]>();
      for (const e of map.edges) {
        if (!outgoing.has(e.from)) outgoing.set(e.from, []);
        outgoing.get(e.from)!.push(e.to);
      }
      for (let lane = 0; lane < map.laneCount; lane++) {
        const seed0 = `n_0_${lane}`;
        // Skip lanes with no depth-0 node (shouldn't happen but guard).
        if (!map.nodes.some((n) => n.id === seed0)) continue;
        const seen = new Set<string>([seed0]);
        const stack = [seed0];
        while (stack.length) {
          const id = stack.pop()!;
          const outs = outgoing.get(id) ?? [];
          for (const to of outs) {
            if (to === "boss") continue;
            if (!seen.has(to)) {
              seen.add(to);
              stack.push(to);
            }
          }
        }
        const hasShrine = [...seen].some(
          (id) => nodeById(map, id)?.kind === "shrine",
        );
        expect(hasShrine).toBe(true);
      }
    }
  });

  it("edges never cross geometrically (no skip-lane / crossing edges)", () => {
    for (const s of seeds) {
      const map = makeMap(s, 2);
      // skip-lane check: edges only span lane difference 0 or 1
      for (const e of map.edges) {
        if (e.from === "start" || e.to === "boss") continue;
        const diff = Math.abs(laneOf(e.from) - laneOf(e.to));
        expect(diff).toBeLessThanOrEqual(1);
      }
      // crossing check: pairwise
      for (let i = 0; i < map.edges.length; i++) {
        for (let j = i + 1; j < map.edges.length; j++) {
          expect(crosses(map.edges[i], map.edges[j])).toBe(false);
        }
      }
    }
  });

  it("start has at least one outgoing; boss has at least one incoming", () => {
    for (const s of seeds) {
      const map = makeMap(s, 2);
      const outsFromStart = map.edges.filter((e) => e.from === "start");
      const inToBoss = map.edges.filter((e) => e.to === "boss");
      expect(outsFromStart.length).toBeGreaterThan(0);
      expect(inToBoss.length).toBeGreaterThan(0);
    }
  });
});

// ---------------- frequency distribution ----------------

describe("generateExpeditionMap — frequency distribution", () => {
  it("over many seeds combat ~50%, elite ~10%, event ~15% of intermediate nodes", () => {
    const seeds = Array.from({ length: 200 }, (_, i) => `freq-${i}`);
    const totals = { combat: 0, elite: 0, event: 0, shrine: 0, camp: 0, treasure: 0, total: 0 };
    for (const s of seeds) {
      const map = makeMap(s, 2);
      // Exclude depth 0 (forced combat) and depth D-1 (forced camp) so we
      // measure the *organic* sampling distribution.
      for (const n of map.nodes) {
        if (n.kind === "start" || n.kind === "boss") continue;
        if (n.depth === 0 || n.depth === map.depth - 1) continue;
        totals[n.kind as keyof Omit<typeof totals, "total">] += 1;
        totals.total += 1;
      }
    }
    // Generous bands — sampling variance with shrine repair can shift the
    // realized share by a few percentage points.
    const pct = (k: keyof typeof totals) =>
      (totals[k] as number) / totals.total;
    expect(pct("combat")).toBeGreaterThan(0.40);
    expect(pct("combat")).toBeLessThan(0.60);
    expect(pct("elite")).toBeGreaterThan(0.04);
    expect(pct("elite")).toBeLessThan(0.18);
    expect(pct("event")).toBeGreaterThan(0.08);
    expect(pct("event")).toBeLessThan(0.22);
  });
});

// ---------------- queries ----------------

describe("availablePicks", () => {
  it("null current_node returns START's outgoing nodes", () => {
    const map = makeMap("picks", 1);
    const picks = availablePicks(map, null);
    expect(picks.length).toBeGreaterThan(0);
    for (const p of picks) {
      expect(p.depth).toBe(0);
    }
  });
  it("from a known node returns its outgoing nodes", () => {
    const map = makeMap("picks2", 2);
    const first = map.nodes.find((n) => n.depth === 0)!;
    const picks = availablePicks(map, first.id);
    const expected = outgoingEdges(map, first.id).map((e) => e.to);
    expect(picks.map((p) => p.id).sort()).toEqual(expected.sort());
  });
  it("boss returns no picks", () => {
    const map = makeMap("picks3", 1);
    expect(availablePicks(map, "boss")).toEqual([]);
  });
});

// ---------------- state machine ----------------

function freshState(map: ExpeditionMap): ExpeditionState {
  return {
    expeditionId: 1,
    map,
    currentNode: null,
    resolved: {},
    party: [],
    status: "active",
  };
}

describe("reduceExpedition", () => {
  it("pick advances current_node and dispatches based on kind", () => {
    const map = makeMap("reduce", 1);
    let state = freshState(map);
    const picks = availablePicks(map, null);
    const target = picks[0];
    const result = reduceExpedition(state, { type: "pick", nodeId: target.id });
    expect(result.state.currentNode).toBe(target.id);
    // depth 0 is always combat, so we should get spawn_combat
    expect(result.dispatch?.kind).toBe("spawn_combat");
  });

  it("pick to an invalid node throws", () => {
    const map = makeMap("reduce-bad", 1);
    const state = freshState(map);
    expect(() =>
      reduceExpedition(state, { type: "pick", nodeId: "boss" }),
    ).toThrow();
  });

  it("resolving the boss marks expedition complete and emits complete_expedition", () => {
    const map = makeMap("reduce-boss", 1);
    let state = freshState(map);
    state = { ...state, currentNode: "boss" };
    const result = reduceExpedition(state, {
      type: "resolve",
      nodeId: "boss",
      outcome: { victory: true },
    });
    expect(result.state.status).toBe("completed");
    expect(result.dispatch?.kind).toBe("complete_expedition");
  });

  it("abandon transitions status to abandoned", () => {
    const map = makeMap("abandon", 1);
    const state = freshState(map);
    const result = reduceExpedition(state, { type: "abandon" });
    expect(result.state.status).toBe("abandoned");
  });
});

// ---------------- kind counts sanity ----------------

describe("countKinds", () => {
  it("totals match the node array length", () => {
    const map = makeMap("count", 2);
    const c = countKinds(map);
    const total = c.combat + c.elite + c.event + c.shrine + c.camp + c.treasure + c.boss + c.start;
    expect(total).toBe(map.nodes.length);
    expect(c.start).toBe(1);
    expect(c.boss).toBe(1);
  });
});
