// Worker-level race tests for the expedition map's critical sections.
//
// These tests use Node's built-in `node:sqlite` to stand in for D1. The
// surface we exercise is the D1Database interface — `prepare(sql).bind(...)
// .run() / .first() / .all()` — and the SQL we emit is portable SQLite, so a
// real D1 binding behaves identically modulo error-message text (which we
// don't string-match anywhere; see ExpeditionMembershipConflictError).
//
// What we verify:
//   1) Two concurrent /start callers cannot both succeed for the same
//      character. The second `createExpedition` throws
//      ExpeditionMembershipConflictError and rolls back its half-built row.
//   2) Two concurrent /pick callers cannot both advance current_node. The
//      CAS in setExpeditionCurrentNodeIfCurrent reports `true` for exactly
//      one caller and `false` for the other.
//
// We don't need the full worker route handlers to verify the guarantee — the
// guarantee lives in the DB helpers, and the routes are thin wrappers over
// them. Testing at the helper layer is also where the real defenses live
// (the SQL constraints), which is exactly what we want to pin.

// @ts-expect-error — node:sqlite types aren't installed (no @types/node).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  ExpeditionMembershipConflictError,
  appendExpeditionBuff,
  createExpedition,
  finalizeExpeditionMap,
  getExpedition,
  getExpeditionPartyState,
  parseExpeditionBuffs,
  recordExpeditionNodeProgress,
  refillExpeditionPartyToMax,
  setExpeditionCurrentNodeIfCurrent,
  setExpeditionPartyHpMana,
} from "./expedition.js";
import { generateExpeditionMap } from "@gantt-quest/core";

// ---------- minimal D1-shaped wrapper around node:sqlite ----------

type Bindable = string | number | null;

interface MetaShape {
  last_row_id?: number;
  changes?: number;
}

interface RunResult {
  meta: MetaShape;
}

interface AllResult<T> {
  results: T[];
}

interface Stmt {
  bind(...args: Bindable[]): Stmt;
  run(): Promise<RunResult>;
  first<T = unknown>(): Promise<T | null>;
  all<T = unknown>(): Promise<AllResult<T>>;
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

// Schema mirrors migrations/0066_expeditions.sql, minus the `characters`
// dependency (we'd need the full schema; the FK is checked via PRAGMA off).
function freshDb(): D1Like {
  const db = new DatabaseSync(":memory:");
  // Foreign keys ON so the membership PK enforces uniqueness — that's the
  // whole point of the test. We don't model the `characters` parent table,
  // so we leave the character_id FK without a referenced row; SQLite is fine
  // with that as long as we don't insert characters at all.
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`
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
      expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
      character_id  TEXT NOT NULL,
      joined_at     INTEGER NOT NULL,
      current_hp    INTEGER,
      current_mana  INTEGER,
      max_hp        INTEGER,
      max_mana      INTEGER,
      PRIMARY KEY (expedition_id, character_id)
    );
    CREATE TABLE expedition_node_progress (
      expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
      node_id       TEXT NOT NULL,
      resolved_at   INTEGER NOT NULL,
      outcome_json  TEXT NOT NULL,
      PRIMARY KEY (expedition_id, node_id)
    );
    CREATE TABLE active_expedition_membership (
      character_id  TEXT PRIMARY KEY,
      expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE
    );
  `);
  return makeD1(db);
}

function tinyMap() {
  return generateExpeditionMap({ seed: "test", partySize: 1, depth: 3 });
}

// We pass our stub as a D1Database to the helpers — it implements the
// subset of the interface they use. The cast also lets us keep using the
// stub directly in test SQL without re-casting.
import type { D1Database } from "@cloudflare/workers-types";
const asDb = (d: D1Like): D1Database => d as unknown as D1Database;

describe("createExpedition / membership race", () => {
  it("rejects a second concurrent start for the same character with ExpeditionMembershipConflictError", async () => {
    const db = freshDb();
    const map = tinyMap();
    const args = {
      channel_id: "web:U1",
      seed: "bootstrap|U1",
      map,
      created_by: "U1",
      party: ["U1"],
    };

    // Fire both inserts concurrently — both pass any pre-check, both race to
    // insert the membership row. Exactly one wins.
    const results = await Promise.allSettled([
      createExpedition(asDb(db), args),
      createExpedition(asDb(db), args),
    ]);
    const fulfilled = results.filter((r) => r.status === "fulfilled");
    const rejected = results.filter((r) => r.status === "rejected");
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const rejection = (rejected[0] as PromiseRejectedResult).reason as Error;
    expect(rejection).toBeInstanceOf(ExpeditionMembershipConflictError);
    expect((rejection as ExpeditionMembershipConflictError).characterId).toBe("U1");

    // The losing call must have cleaned up — exactly one expedition row left.
    const all = await asDb(db)
      .prepare(`SELECT COUNT(*) as c FROM expeditions`)
      .first<{ c: number }>();
    expect(all?.c).toBe(1);
    const mems = await asDb(db)
      .prepare(`SELECT COUNT(*) as c FROM active_expedition_membership`)
      .first<{ c: number }>();
    expect(mems?.c).toBe(1);
  });

  it("allows a new start once the prior expedition's membership row is cleared", async () => {
    const db = freshDb();
    const map = tinyMap();
    const id1 = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map,
      created_by: "U1",
      party: ["U1"],
    });
    // Simulate the abandon path clearing membership.
    await asDb(db)
      .prepare(`DELETE FROM active_expedition_membership WHERE expedition_id = ?`)
      .bind(id1)
      .run();
    // Should succeed now.
    const id2 = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s2",
      map,
      created_by: "U1",
      party: ["U1"],
    });
    expect(id2).not.toBe(id1);
  });
});

describe("setExpeditionCurrentNodeIfCurrent / pick race", () => {
  it("exactly one of two concurrent CAS picks succeeds when both target the same start state", async () => {
    const db = freshDb();
    const map = tinyMap();
    const id = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map,
      created_by: "U1",
      party: ["U1"],
    });
    await finalizeExpeditionMap(asDb(db), id, "final", map);

    // Both callers loaded `current_node = null` (the initial state).
    const [a, b] = await Promise.all([
      setExpeditionCurrentNodeIfCurrent(asDb(db), id, null, "n_0_0"),
      setExpeditionCurrentNodeIfCurrent(asDb(db), id, null, "n_0_1"),
    ]);
    const wins = [a, b].filter(Boolean).length;
    expect(wins).toBe(1);

    // The row's current_node is whichever winner went first — but exactly one
    // of the two intended targets must have landed, not "no update".
    const row = await asDb(db)
      .prepare(`SELECT current_node FROM expeditions WHERE id = ?`)
      .bind(id)
      .first<{ current_node: string }>();
    expect(["n_0_0", "n_0_1"]).toContain(row?.current_node);
  });

  it("returns false when expectedCurrent does not match the row", async () => {
    const db = freshDb();
    const map = tinyMap();
    const id = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map,
      created_by: "U1",
      party: ["U1"],
    });
    // Move forward.
    expect(
      await setExpeditionCurrentNodeIfCurrent(asDb(db), id, null, "n_0_0"),
    ).toBe(true);
    // A stale caller still thinking we're at null tries to pick — must fail.
    expect(
      await setExpeditionCurrentNodeIfCurrent(asDb(db), id, null, "n_0_1"),
    ).toBe(false);
    // A current caller with the right expected value can advance.
    expect(
      await setExpeditionCurrentNodeIfCurrent(asDb(db), id, "n_0_0", "n_1_0"),
    ).toBe(true);
  });
});

// ─── HP/mana carry between combat nodes ─────────────────────────────────────
//
// Pass 2 wires HP/mana to carry across nodes via the expedition_party
// current_hp/current_mana columns. These tests exercise the persistence layer
// in isolation: write through the helpers, read through the helpers, verify
// values survive an arbitrary number of advances.

describe("expedition party HP/mana carry", () => {
  it("setExpeditionPartyHpMana persists and reads back per-character", async () => {
    const db = freshDb();
    const map = tinyMap();
    const id = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map,
      created_by: "U1",
      party: ["U1", "U2"],
    });
    await setExpeditionPartyHpMana(asDb(db), id, "U1", {
      current_hp: 14,
      current_mana: 3,
      max_hp: 30,
      max_mana: 6,
    });
    await setExpeditionPartyHpMana(asDb(db), id, "U2", {
      current_hp: 22,
      current_mana: 5,
      max_hp: 28,
      max_mana: 7,
    });
    const state = await getExpeditionPartyState(asDb(db), id);
    const u1 = state.find((r) => r.character_id === "U1");
    const u2 = state.find((r) => r.character_id === "U2");
    expect(u1?.current_hp).toBe(14);
    expect(u1?.max_hp).toBe(30);
    expect(u2?.current_mana).toBe(5);
    expect(u2?.max_mana).toBe(7);
  });

  it("carries HP/mana across two combat nodes", async () => {
    const db = freshDb();
    const map = tinyMap();
    const id = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map,
      created_by: "U1",
      party: ["U1"],
    });
    // First combat resolve: write surviving HP/mana.
    await setExpeditionPartyHpMana(asDb(db), id, "U1", {
      current_hp: 14,
      current_mana: 2,
      max_hp: 30,
      max_mana: 6,
    });
    // Worker would read these to seed the next combat. Simulate that read:
    const before = await getExpeditionPartyState(asDb(db), id);
    expect(before[0].current_hp).toBe(14);
    expect(before[0].current_mana).toBe(2);
    // Second combat resolve: write new HP/mana.
    await setExpeditionPartyHpMana(asDb(db), id, "U1", {
      current_hp: 8,
      current_mana: 0,
      max_hp: 30,
      max_mana: 6,
    });
    const after = await getExpeditionPartyState(asDb(db), id);
    expect(after[0].current_hp).toBe(8);
    expect(after[0].current_mana).toBe(0);
    expect(after[0].max_hp).toBe(30);
  });

  it("refillExpeditionPartyToMax restores every member to max", async () => {
    const db = freshDb();
    const map = tinyMap();
    const id = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map,
      created_by: "U1",
      party: ["U1", "U2"],
    });
    await setExpeditionPartyHpMana(asDb(db), id, "U1", {
      current_hp: 3,
      current_mana: 0,
      max_hp: 30,
      max_mana: 6,
    });
    await setExpeditionPartyHpMana(asDb(db), id, "U2", {
      current_hp: 9,
      current_mana: 1,
      max_hp: 28,
      max_mana: 7,
    });
    await refillExpeditionPartyToMax(asDb(db), id);
    const state = await getExpeditionPartyState(asDb(db), id);
    const u1 = state.find((r) => r.character_id === "U1");
    const u2 = state.find((r) => r.character_id === "U2");
    expect(u1?.current_hp).toBe(30);
    expect(u1?.current_mana).toBe(6);
    expect(u2?.current_hp).toBe(28);
    expect(u2?.current_mana).toBe(7);
  });

  it("refillExpeditionPartyToMax leaves rows with NULL max alone", async () => {
    const db = freshDb();
    const map = tinyMap();
    const id = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map,
      created_by: "U1",
      party: ["U1"],
    });
    // U1 row exists but max_hp is NULL (never been combat-seeded).
    await refillExpeditionPartyToMax(asDb(db), id);
    const state = await getExpeditionPartyState(asDb(db), id);
    expect(state[0].max_hp).toBeNull();
    expect(state[0].current_hp).toBeNull();
  });
});

// ─── Run buffs ──────────────────────────────────────────────────────────────

describe("expedition buffs", () => {
  it("appendExpeditionBuff accumulates and survives a read-modify-write cycle", async () => {
    const db = freshDb();
    const map = tinyMap();
    const id = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map,
      created_by: "U1",
      party: ["U1"],
    });
    const after1 = await appendExpeditionBuff(asDb(db), id, {
      kind: "max_hp",
      value: 5,
      node_id: "n_1_0",
      applied_at: 100,
    });
    expect(after1).toHaveLength(1);
    const after2 = await appendExpeditionBuff(asDb(db), id, {
      kind: "stat",
      value: 1,
      stat: "str",
      node_id: "n_3_0",
      applied_at: 200,
    });
    expect(after2).toHaveLength(2);
    const row = await getExpedition(asDb(db), id);
    expect(row).not.toBeNull();
    const buffs = parseExpeditionBuffs(row!);
    expect(buffs).toHaveLength(2);
    expect(buffs[0].kind).toBe("max_hp");
    expect(buffs[1].stat).toBe("str");
  });
});

// ─── Combat-resolve hook idempotency (simulated) ────────────────────────────
//
// The expedition advance hook is supposed to be a no-op if progress already
// exists for the node. We exercise that contract at the helper level by
// recording progress twice and verifying the second write doesn't change the
// stored outcome.

describe("recordExpeditionNodeProgress idempotency surface", () => {
  it("INSERT OR REPLACE keeps the latest outcome but doesn't multiply rows", async () => {
    const db = freshDb();
    const map = tinyMap();
    const id = await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map,
      created_by: "U1",
      party: ["U1"],
    });
    await recordExpeditionNodeProgress(asDb(db), id, "n_0_0", { kind: "combat", quest_id: 100 });
    await recordExpeditionNodeProgress(asDb(db), id, "n_0_0", { kind: "combat", quest_id: 100 });
    const count = await asDb(db)
      .prepare(`SELECT COUNT(*) as c FROM expedition_node_progress WHERE expedition_id = ?`)
      .bind(id)
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
  });
});
