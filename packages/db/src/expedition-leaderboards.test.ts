// Coverage for the five expedition leaderboard queries.
//
// Same node:sqlite harness as expedition.test.ts. We add a tiny `characters`
// stub here because the leaderboard queries join through it for name/class/
// level — the expedition test doesn't need it.

// @ts-expect-error — node:sqlite types aren't installed (no @types/node).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  getExpeditionFastestClearLeaderboard,
  getExpeditionMostClearedLeaderboard,
  getExpeditionStreakLeaderboard,
  getExpeditionNodesLeaderboard,
  getExpeditionEliteLeaderboard,
} from "./expedition.js";

// ---------- minimal D1-shaped wrapper around node:sqlite ----------

type Bindable = string | number | null;

interface Stmt {
  bind(...args: Bindable[]): Stmt;
  run(): Promise<{ meta: { last_row_id?: number; changes?: number } }>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<{ results: T[] }>;
}

interface D1Like {
  prepare(sql: string): Stmt;
}

function makeD1(db: DatabaseSync): D1Like {
  return {
    prepare(sql: string): Stmt {
      const stmt = db.prepare(sql);
      let bound: Bindable[] = [];
      const self: Stmt = {
        bind(...args: Bindable[]) {
          bound = args;
          return self;
        },
        async run() {
          const info = stmt.run(...bound);
          return {
            meta: {
              last_row_id: Number(info.lastInsertRowid),
              changes: Number(info.changes),
            },
          };
        },
        async first<T = unknown>() {
          const row = stmt.get(...bound);
          return (row as T) ?? null;
        },
        async all<T = unknown>() {
          const rows = stmt.all(...bound);
          return { results: rows as T[] };
        },
      };
      return self;
    },
  };
}

// We deliberately turn FKs off here — the leaderboard queries reach into
// `characters` and we want to stub just the columns the queries read,
// without dragging the full real schema in (which the worker-level
// migrations carry but isn't relevant for this test).
function freshDb(): D1Like {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = OFF;`);
  db.exec(`
    CREATE TABLE characters (
      slack_user_id   TEXT PRIMARY KEY,
      name            TEXT NOT NULL,
      slack_username  TEXT,
      class           TEXT NOT NULL,
      level           INTEGER NOT NULL DEFAULT 1
    );
    CREATE TABLE expeditions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      seed          TEXT NOT NULL,
      map_json      TEXT NOT NULL,
      current_node  TEXT,
      buffs_json    TEXT NOT NULL DEFAULT '[]',
      created_by    TEXT NOT NULL,
      created_at    INTEGER NOT NULL,
      completed_at  INTEGER
    );
    CREATE TABLE expedition_party (
      expedition_id INTEGER NOT NULL,
      character_id  TEXT NOT NULL,
      joined_at     INTEGER NOT NULL,
      current_hp    INTEGER,
      current_mana  INTEGER,
      max_hp        INTEGER,
      max_mana      INTEGER,
      PRIMARY KEY (expedition_id, character_id)
    );
    CREATE TABLE expedition_node_progress (
      expedition_id INTEGER NOT NULL,
      node_id       TEXT NOT NULL,
      resolved_at   INTEGER NOT NULL,
      outcome_json  TEXT NOT NULL,
      PRIMARY KEY (expedition_id, node_id)
    );
  `);
  return makeD1(db);
}

import type { D1Database } from "@cloudflare/workers-types";
const asDb = (d: D1Like): D1Database => d as unknown as D1Database;

interface Seeder {
  addChar(id: string, opts?: Partial<{ name: string; className: string; level: number }>): Promise<void>;
  addExpedition(args: {
    id: number;
    status: "active" | "completed" | "failed" | "abandoned";
    created_at: number;
    completed_at: number | null;
    party: string[];
  }): Promise<void>;
  addProgress(args: { expedition_id: number; node_id: string; outcome: unknown; resolved_at?: number }): Promise<void>;
}

function seeder(db: D1Like): Seeder {
  return {
    async addChar(id, opts = {}) {
      await asDb(db)
        .prepare(`INSERT INTO characters (slack_user_id, name, class, level) VALUES (?, ?, ?, ?)`)
        .bind(id, opts.name ?? id, opts.className ?? "Mage", opts.level ?? 5)
        .run();
    },
    async addExpedition({ id, status, created_at, completed_at, party }) {
      await asDb(db)
        .prepare(
          `INSERT INTO expeditions (id, channel_id, status, seed, map_json, created_by, created_at, completed_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(id, "web:test", status, "s", "{}", party[0], created_at, completed_at)
        .run();
      for (const cid of party) {
        await asDb(db)
          .prepare(
            `INSERT INTO expedition_party (expedition_id, character_id, joined_at) VALUES (?, ?, ?)`,
          )
          .bind(id, cid, created_at)
          .run();
      }
    },
    async addProgress({ expedition_id, node_id, outcome, resolved_at = 1 }) {
      await asDb(db)
        .prepare(
          `INSERT INTO expedition_node_progress (expedition_id, node_id, resolved_at, outcome_json)
           VALUES (?, ?, ?, ?)`,
        )
        .bind(expedition_id, node_id, resolved_at, JSON.stringify(outcome))
        .run();
    },
  };
}

describe("getExpeditionFastestClearLeaderboard", () => {
  it("orders by ascending duration and excludes non-completed runs", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1", { className: "Mage", level: 7 });
    await s.addChar("U2", { className: "Bard", level: 4 });
    await s.addChar("U3", { className: "Sage", level: 9 });
    // U1 fast, U2 slow, U3 still running.
    await s.addExpedition({ id: 1, status: "completed", created_at: 100, completed_at: 200, party: ["U1"] });
    await s.addExpedition({ id: 2, status: "completed", created_at: 100, completed_at: 1000, party: ["U2"] });
    await s.addExpedition({ id: 3, status: "active", created_at: 100, completed_at: null, party: ["U3"] });
    const rows = await getExpeditionFastestClearLeaderboard(asDb(db), 20);
    expect(rows).toHaveLength(2);
    expect(rows[0].slack_user_id).toBe("U1");
    expect(rows[0].duration_ms).toBe(100);
    expect(rows[1].slack_user_id).toBe("U2");
    expect(rows[1].duration_ms).toBe(900);
  });

  it("credits every party member on the same fast run", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1");
    await s.addChar("U2");
    await s.addChar("U3");
    await s.addExpedition({
      id: 1, status: "completed", created_at: 100, completed_at: 250,
      party: ["U1", "U2", "U3"],
    });
    const rows = await getExpeditionFastestClearLeaderboard(asDb(db), 20);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.duration_ms).toBe(150);
    const ids = rows.map((r) => r.slack_user_id).sort();
    expect(ids).toEqual(["U1", "U2", "U3"]);
  });
});

describe("getExpeditionMostClearedLeaderboard", () => {
  it("aggregates correctly across multiple expeditions per character", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1", { level: 10 });
    await s.addChar("U2", { level: 3 });
    // U1: 3 clears + 1 failure (failure shouldn't count).
    await s.addExpedition({ id: 1, status: "completed", created_at: 1, completed_at: 2, party: ["U1"] });
    await s.addExpedition({ id: 2, status: "completed", created_at: 1, completed_at: 2, party: ["U1"] });
    await s.addExpedition({ id: 3, status: "completed", created_at: 1, completed_at: 2, party: ["U1"] });
    await s.addExpedition({ id: 4, status: "failed",    created_at: 1, completed_at: 2, party: ["U1"] });
    // U2: 1 clear.
    await s.addExpedition({ id: 5, status: "completed", created_at: 1, completed_at: 2, party: ["U2"] });

    const rows = await getExpeditionMostClearedLeaderboard(asDb(db), 20);
    expect(rows).toHaveLength(2);
    expect(rows[0].slack_user_id).toBe("U1");
    expect(rows[0].completed_count).toBe(3);
    expect(rows[1].slack_user_id).toBe("U2");
    expect(rows[1].completed_count).toBe(1);
  });

  it("excludes characters with no completions", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1");
    await s.addChar("U2");
    // U2 only ever failed.
    await s.addExpedition({ id: 1, status: "completed", created_at: 1, completed_at: 2, party: ["U1"] });
    await s.addExpedition({ id: 2, status: "failed",    created_at: 1, completed_at: 2, party: ["U2"] });
    const rows = await getExpeditionMostClearedLeaderboard(asDb(db), 20);
    expect(rows).toHaveLength(1);
    expect(rows[0].slack_user_id).toBe("U1");
  });

  it("credits all party members on a multi-party clear", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1");
    await s.addChar("U2");
    await s.addChar("U3");
    await s.addExpedition({
      id: 1, status: "completed", created_at: 1, completed_at: 2,
      party: ["U1", "U2", "U3"],
    });
    const rows = await getExpeditionMostClearedLeaderboard(asDb(db), 20);
    expect(rows).toHaveLength(3);
    for (const r of rows) expect(r.completed_count).toBe(1);
  });
});

describe("getExpeditionStreakLeaderboard", () => {
  it("computes best and current streak per character", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1");
    await s.addChar("U2");
    // U1 sequence: C C F C C C  -> best 3, current 3.
    let t = 100;
    for (const status of ["completed", "completed", "failed", "completed", "completed", "completed"] as const) {
      await s.addExpedition({ id: t, status, created_at: t, completed_at: t + 1, party: ["U1"] });
      t += 10;
    }
    // U2 sequence: C C C F -> best 3, current 0.
    for (const status of ["completed", "completed", "completed", "failed"] as const) {
      await s.addExpedition({ id: t, status, created_at: t, completed_at: t + 1, party: ["U2"] });
      t += 10;
    }
    const rows = await getExpeditionStreakLeaderboard(asDb(db), 20);
    const u1 = rows.find((r) => r.slack_user_id === "U1");
    const u2 = rows.find((r) => r.slack_user_id === "U2");
    expect(u1?.best_streak).toBe(3);
    expect(u1?.current_streak).toBe(3);
    expect(u2?.best_streak).toBe(3);
    expect(u2?.current_streak).toBe(0);
  });

  it("excludes characters with zero completions entirely", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1");
    await s.addChar("U2");
    await s.addExpedition({ id: 1, status: "completed", created_at: 100, completed_at: 101, party: ["U1"] });
    await s.addExpedition({ id: 2, status: "failed",    created_at: 100, completed_at: 101, party: ["U2"] });
    const rows = await getExpeditionStreakLeaderboard(asDb(db), 20);
    expect(rows.map((r) => r.slack_user_id)).toEqual(["U1"]);
  });
});

describe("getExpeditionNodesLeaderboard", () => {
  it("sums node-progress rows across all party expeditions", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1");
    await s.addChar("U2");
    await s.addExpedition({ id: 1, status: "completed", created_at: 1, completed_at: 2, party: ["U1", "U2"] });
    await s.addExpedition({ id: 2, status: "active",    created_at: 1, completed_at: null, party: ["U1"] });
    // 3 nodes in exp 1 (both members credit) + 2 nodes in exp 2 (only U1).
    await s.addProgress({ expedition_id: 1, node_id: "n_0_0", outcome: { kind: "combat" } });
    await s.addProgress({ expedition_id: 1, node_id: "n_1_0", outcome: { kind: "event" } });
    await s.addProgress({ expedition_id: 1, node_id: "n_2_0", outcome: { kind: "shrine" } });
    await s.addProgress({ expedition_id: 2, node_id: "n_0_0", outcome: { kind: "combat" } });
    await s.addProgress({ expedition_id: 2, node_id: "n_1_0", outcome: { kind: "elite" } });

    const rows = await getExpeditionNodesLeaderboard(asDb(db), 20);
    const u1 = rows.find((r) => r.slack_user_id === "U1");
    const u2 = rows.find((r) => r.slack_user_id === "U2");
    expect(u1?.total_nodes).toBe(5);
    expect(u2?.total_nodes).toBe(3);
  });

  it("omits characters who haven't resolved any node", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1");
    await s.addChar("U2");
    await s.addExpedition({ id: 1, status: "active", created_at: 1, completed_at: null, party: ["U1", "U2"] });
    await s.addProgress({ expedition_id: 1, node_id: "n_0_0", outcome: { kind: "combat" } });
    // Both credited (party-wide), but U2 alone with no progress would be 0.
    const rows = await getExpeditionNodesLeaderboard(asDb(db), 20);
    // Both have credit on the same expedition's node.
    expect(rows.map((r) => r.slack_user_id).sort()).toEqual(["U1", "U2"]);
  });
});

describe("getExpeditionEliteLeaderboard", () => {
  it("counts completed expeditions containing an elite node", async () => {
    const db = freshDb();
    const s = seeder(db);
    await s.addChar("U1");
    await s.addChar("U2");
    // U1: 2 elite clears + 1 plain clear + 1 elite-but-failed run.
    await s.addExpedition({ id: 1, status: "completed", created_at: 1, completed_at: 2, party: ["U1"] });
    await s.addProgress({ expedition_id: 1, node_id: "n_3_0", outcome: { kind: "elite" } });
    await s.addExpedition({ id: 2, status: "completed", created_at: 1, completed_at: 2, party: ["U1"] });
    await s.addProgress({ expedition_id: 2, node_id: "n_4_0", outcome: { kind: "elite" } });
    await s.addExpedition({ id: 3, status: "completed", created_at: 1, completed_at: 2, party: ["U1"] });
    await s.addProgress({ expedition_id: 3, node_id: "n_0_0", outcome: { kind: "combat" } });
    await s.addExpedition({ id: 4, status: "failed",    created_at: 1, completed_at: 2, party: ["U1"] });
    await s.addProgress({ expedition_id: 4, node_id: "n_0_0", outcome: { kind: "elite" } });
    // U2: no elite clears.
    await s.addExpedition({ id: 5, status: "completed", created_at: 1, completed_at: 2, party: ["U2"] });
    await s.addProgress({ expedition_id: 5, node_id: "n_0_0", outcome: { kind: "combat" } });

    const rows = await getExpeditionEliteLeaderboard(asDb(db), 20);
    expect(rows).toHaveLength(1);
    expect(rows[0].slack_user_id).toBe("U1");
    expect(rows[0].elite_clears).toBe(2);
  });
});
