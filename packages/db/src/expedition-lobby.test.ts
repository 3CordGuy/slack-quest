// Tests for the expedition party lobby + invites feature.
//
// Mirrors expedition.test.ts: node:sqlite stands in for D1, schema is the
// minimum subset of the live migrations (0066 + 0068) we exercise. The
// guarantee under test lives in the DB helpers in ./expedition.ts; the worker
// routes are thin wrappers over them.

// @ts-expect-error — node:sqlite types aren't installed (no @types/node).
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import type { D1Database } from "@cloudflare/workers-types";
import {
  ExpeditionMembershipConflictError,
  acceptExpeditionLobbyInvite,
  addExpeditionLobbyInvitee,
  countPendingExpeditionInvitees,
  createExpedition,
  createExpeditionLobby,
  declineExpeditionLobbyInvite,
  deleteExpeditionLobby,
  getExpeditionLobbyMembers,
  getExpeditionParty,
  getLobbyExpeditionForCharacter,
  setExpeditionCurrentNodeIfCurrent,
  setExpeditionStatus,
} from "./expedition.js";
import { generateExpeditionMap } from "@gantt-quest/core";

// ---------- minimal D1-shaped wrapper around node:sqlite (same as expedition.test.ts) ----------

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

// Schema mirrors migrations/0066 + 0068. We include a stub `characters` table
// because getExpeditionLobbyMembers joins on it (the lobby UI needs name +
// level + class for each row).
function freshDb(): D1Like {
  const db = new DatabaseSync(":memory:");
  db.exec(`PRAGMA foreign_keys = ON;`);
  db.exec(`
    CREATE TABLE characters (
      slack_user_id  TEXT PRIMARY KEY,
      name           TEXT NOT NULL,
      slack_username TEXT,
      level          INTEGER NOT NULL DEFAULT 1,
      class          TEXT NOT NULL DEFAULT 'wanderer'
    );
    CREATE TABLE expeditions (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id    TEXT NOT NULL,
      status        TEXT NOT NULL DEFAULT 'active',
      seed          TEXT NOT NULL,
      map_json      TEXT NOT NULL,
      current_node  TEXT,
      buffs_json    TEXT NOT NULL DEFAULT '[]',
      created_by    TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
      created_at    INTEGER NOT NULL,
      completed_at  INTEGER
    );
    -- Note: 0068 adds invite_status with DEFAULT 'accepted' (back-compat)
    CREATE TABLE expedition_party (
      expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE,
      character_id  TEXT NOT NULL REFERENCES characters(slack_user_id) ON DELETE CASCADE,
      joined_at     INTEGER NOT NULL,
      current_hp    INTEGER,
      current_mana  INTEGER,
      max_hp        INTEGER,
      max_mana      INTEGER,
      invite_status TEXT NOT NULL DEFAULT 'accepted',
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
      character_id  TEXT PRIMARY KEY REFERENCES characters(slack_user_id) ON DELETE CASCADE,
      expedition_id INTEGER NOT NULL REFERENCES expeditions(id) ON DELETE CASCADE
    );
  `);
  return makeD1(db);
}

const asDb = (d: D1Like): D1Database => d as unknown as D1Database;

function tinyMap() {
  return generateExpeditionMap({ seed: "test", partySize: 1, depth: 3 });
}

async function seedCharacter(
  db: D1Like,
  id: string,
  name = id,
): Promise<void> {
  await asDb(db)
    .prepare(`INSERT INTO characters (slack_user_id, name, level, class) VALUES (?, ?, 5, 'rogue')`)
    .bind(id, name)
    .run();
}

describe("createExpeditionLobby", () => {
  it("creates a lobby-status expedition with only the creator accepted", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    const id = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map: tinyMap(),
      created_by: "U1",
    });
    const row = await asDb(db)
      .prepare(`SELECT status FROM expeditions WHERE id = ?`)
      .bind(id)
      .first<{ status: string }>();
    expect(row?.status).toBe("lobby");
    const members = await getExpeditionLobbyMembers(asDb(db), id);
    expect(members).toHaveLength(1);
    expect(members[0].character_id).toBe("U1");
    expect(members[0].invite_status).toBe("accepted");
    // Membership row was reserved for the creator.
    const m = await asDb(db)
      .prepare(`SELECT character_id FROM active_expedition_membership WHERE expedition_id = ?`)
      .bind(id)
      .all<{ character_id: string }>();
    expect(m.results).toHaveLength(1);
  });

  it("blocks a creator already in another expedition (mutex)", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    await createExpedition(asDb(db), {
      channel_id: "web:U1",
      seed: "s",
      map: tinyMap(),
      created_by: "U1",
      party: ["U1"],
    });
    await expect(
      createExpeditionLobby(asDb(db), {
        channel_id: "web:U1",
        seed: "s2",
        map: tinyMap(),
        created_by: "U1",
      }),
    ).rejects.toBeInstanceOf(ExpeditionMembershipConflictError);
    // Cleanup: only the original expedition remains.
    const count = await asDb(db)
      .prepare(`SELECT COUNT(*) as c FROM expeditions`)
      .first<{ c: number }>();
    expect(count?.c).toBe(1);
  });
});

describe("invite / accept / decline flow", () => {
  it("addExpeditionLobbyInvitee inserts a pending row without a membership row", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    await seedCharacter(db, "U2");
    const id = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1", seed: "s", map: tinyMap(), created_by: "U1",
    });
    const inserted = await addExpeditionLobbyInvitee(asDb(db), id, "U2");
    expect(inserted).toBe(true);
    const members = await getExpeditionLobbyMembers(asDb(db), id);
    expect(members.find((m) => m.character_id === "U2")?.invite_status).toBe("pending");
    // U2 has NO active_expedition_membership row yet — they could still
    // collide on accept. This is critical: holding a pending invite must not
    // block U2 from being invited elsewhere.
    const mems = await asDb(db)
      .prepare(`SELECT character_id FROM active_expedition_membership`)
      .all<{ character_id: string }>();
    expect(mems.results.map((r) => r.character_id)).toEqual(["U1"]);
  });

  it("acceptExpeditionLobbyInvite flips status + reserves membership", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    await seedCharacter(db, "U2");
    const id = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1", seed: "s", map: tinyMap(), created_by: "U1",
    });
    await addExpeditionLobbyInvitee(asDb(db), id, "U2");
    await acceptExpeditionLobbyInvite(asDb(db), id, "U2");
    const members = await getExpeditionLobbyMembers(asDb(db), id);
    expect(members.find((m) => m.character_id === "U2")?.invite_status).toBe("accepted");
    // U2's membership row now exists — the mutex is held.
    const mems = await asDb(db)
      .prepare(`SELECT character_id FROM active_expedition_membership WHERE character_id = ?`)
      .bind("U2")
      .first();
    expect(mems).not.toBeNull();
  });

  it("acceptExpeditionLobbyInvite throws if invitee is in another expedition", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    await seedCharacter(db, "U2");
    await seedCharacter(db, "U3");
    // U2 is already in expedition A.
    await createExpedition(asDb(db), {
      channel_id: "web:U2", seed: "a", map: tinyMap(), created_by: "U2", party: ["U2"],
    });
    // U1 creates lobby B and invites U2.
    const idB = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1", seed: "b", map: tinyMap(), created_by: "U1",
    });
    await addExpeditionLobbyInvitee(asDb(db), idB, "U2");
    // U2 tries to accept B's invite — race-lost.
    await expect(
      acceptExpeditionLobbyInvite(asDb(db), idB, "U2"),
    ).rejects.toBeInstanceOf(ExpeditionMembershipConflictError);
    // U2's invite is reverted to pending so the UI re-prompts.
    const m = await getExpeditionLobbyMembers(asDb(db), idB);
    expect(m.find((r) => r.character_id === "U2")?.invite_status).toBe("pending");
  });

  it("declineExpeditionLobbyInvite removes the row", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    await seedCharacter(db, "U2");
    const id = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1", seed: "s", map: tinyMap(), created_by: "U1",
    });
    await addExpeditionLobbyInvitee(asDb(db), id, "U2");
    await declineExpeditionLobbyInvite(asDb(db), id, "U2");
    const members = await getExpeditionLobbyMembers(asDb(db), id);
    expect(members.find((m) => m.character_id === "U2")).toBeUndefined();
  });
});

describe("begin gate", () => {
  it("countPendingExpeditionInvitees reflects pending vs accepted", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    await seedCharacter(db, "U2");
    await seedCharacter(db, "U3");
    const id = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1", seed: "s", map: tinyMap(), created_by: "U1",
    });
    expect(await countPendingExpeditionInvitees(asDb(db), id)).toBe(0);
    await addExpeditionLobbyInvitee(asDb(db), id, "U2");
    await addExpeditionLobbyInvitee(asDb(db), id, "U3");
    expect(await countPendingExpeditionInvitees(asDb(db), id)).toBe(2);
    await acceptExpeditionLobbyInvite(asDb(db), id, "U2");
    expect(await countPendingExpeditionInvitees(asDb(db), id)).toBe(1);
    await declineExpeditionLobbyInvite(asDb(db), id, "U3");
    expect(await countPendingExpeditionInvitees(asDb(db), id)).toBe(0);
  });
});

describe("lobby surface for current user", () => {
  it("getLobbyExpeditionForCharacter returns the lobby for creator and invitees", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    await seedCharacter(db, "U2");
    const id = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1", seed: "s", map: tinyMap(), created_by: "U1",
    });
    await addExpeditionLobbyInvitee(asDb(db), id, "U2");
    const creator = await getLobbyExpeditionForCharacter(asDb(db), "U1");
    expect(creator?.expedition.id).toBe(id);
    expect(creator?.myInviteStatus).toBe("accepted");
    const invitee = await getLobbyExpeditionForCharacter(asDb(db), "U2");
    expect(invitee?.expedition.id).toBe(id);
    expect(invitee?.myInviteStatus).toBe("pending");
  });

  it("getLobbyExpeditionForCharacter returns null after pick (lobby closed)", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    const id = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1", seed: "s", map: tinyMap(), created_by: "U1",
    });
    // Pretend /begin → status='active', then /pick → current_node set
    await setExpeditionStatus(asDb(db), id, "active");
    // Wait — setExpeditionStatus deletes membership for terminal statuses,
    // and 'active' is non-terminal. Verify membership survives:
    const m = await asDb(db)
      .prepare(`SELECT character_id FROM active_expedition_membership`)
      .all<{ character_id: string }>();
    expect(m.results).toHaveLength(1);
    await setExpeditionCurrentNodeIfCurrent(asDb(db), id, null, "n_0_0");
    const after = await getLobbyExpeditionForCharacter(asDb(db), "U1");
    expect(after).toBeNull();
  });
});

describe("getExpeditionParty filters to accepted", () => {
  it("returns only accepted members (pending invitees excluded)", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    await seedCharacter(db, "U2");
    await seedCharacter(db, "U3");
    const id = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1", seed: "s", map: tinyMap(), created_by: "U1",
    });
    await addExpeditionLobbyInvitee(asDb(db), id, "U2");
    await addExpeditionLobbyInvitee(asDb(db), id, "U3");
    await acceptExpeditionLobbyInvite(asDb(db), id, "U2");
    const party = await getExpeditionParty(asDb(db), id);
    expect(party.sort()).toEqual(["U1", "U2"]);
  });
});

describe("deleteExpeditionLobby", () => {
  it("removes the expedition row + cascades party + membership", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    await seedCharacter(db, "U2");
    const id = await createExpeditionLobby(asDb(db), {
      channel_id: "web:U1", seed: "s", map: tinyMap(), created_by: "U1",
    });
    await addExpeditionLobbyInvitee(asDb(db), id, "U2");
    await deleteExpeditionLobby(asDb(db), id);
    const ex = await asDb(db)
      .prepare(`SELECT id FROM expeditions WHERE id = ?`).bind(id).first();
    expect(ex).toBeNull();
    const party = await asDb(db)
      .prepare(`SELECT character_id FROM expedition_party WHERE expedition_id = ?`).bind(id).all();
    expect(party.results).toHaveLength(0);
    const mem = await asDb(db)
      .prepare(`SELECT character_id FROM active_expedition_membership WHERE expedition_id = ?`).bind(id).all();
    expect(mem.results).toHaveLength(0);
  });

  it("refuses to delete a non-lobby expedition (defensive)", async () => {
    const db = freshDb();
    await seedCharacter(db, "U1");
    const id = await createExpedition(asDb(db), {
      channel_id: "web:U1", seed: "s", map: tinyMap(), created_by: "U1", party: ["U1"],
    });
    await deleteExpeditionLobby(asDb(db), id);
    const ex = await asDb(db)
      .prepare(`SELECT id FROM expeditions WHERE id = ?`).bind(id).first();
    expect(ex).not.toBeNull();
  });
});
