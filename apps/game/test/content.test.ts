// Admin content overrides: the allow-list, every validator, and the D1
// store (history, revert, version bumps) against a real SQLite database with
// the game's migrations applied, using the same D1 stand-in as trade.test.ts.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import {
  PNG_MAX_BYTES,
  checkImport,
  checkOverride,
  contentBundle,
  contentVersion,
  deleteOverride,
  isAdmin,
  overrideHistory,
  pngSize,
  putOverride,
  putOverrides,
} from "../src/server/content";

type Row = Record<string, unknown>;

class Stmt {
  constructor(private sql: DatabaseSync, private text: string, private args: unknown[] = []) {}
  bind(...args: unknown[]) {
    return new Stmt(this.sql, this.text, args);
  }
  exec() {
    const stmt = this.sql.prepare(this.text);
    if (/^\s*(SELECT|WITH)/i.test(this.text)) return { results: stmt.all(...(this.args as never[])) as Row[], meta: { changes: 0, last_row_id: 0 } };
    const res = stmt.run(...(this.args as never[]));
    return { results: [] as Row[], meta: { changes: Number(res.changes), last_row_id: Number(res.lastInsertRowid) } };
  }
  async run() {
    return this.exec();
  }
  async all() {
    return this.exec();
  }
  async first() {
    return this.exec().results[0] ?? null;
  }
}

function openDb() {
  const sql = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  const db = {
    prepare: (text: string) => new Stmt(sql, text),
    async batch(stmts: Stmt[]) {
      sql.exec("BEGIN");
      try {
        const out = stmts.map((s) => s.exec());
        sql.exec("COMMIT");
        return out;
      } catch (err) {
        sql.exec("ROLLBACK");
        throw err;
      }
    },
  };
  return { sql, db: db as unknown as D1Database };
}


/** Just enough of a PNG for the size check: signature and an IHDR chunk header, padded to `bytes`. */
function fakePng(w: number, h: number, bytes = 40): string {
  const buf = new Uint8Array(Math.max(bytes, 33));
  buf.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const view = new DataView(buf.buffer);
  view.setUint32(16, w);
  view.setUint32(20, h);
  return Buffer.from(buf).toString("base64");
}

describe("isAdmin", () => {
  const env = { ADMIN_EMAILS: " Ann@Example.com , bo@example.com" };
  it("matches the allow-list without regard to case or spaces", () => {
    expect(isAdmin(env, { email: "ann@example.com" })).toBe(true);
    expect(isAdmin(env, { email: "BO@example.com" })).toBe(true);
  });
  it("refuses guests, strangers, and everyone when the secret is unset", () => {
    expect(isAdmin(env, { email: null })).toBe(false);
    expect(isAdmin(env, { email: "cy@example.com" })).toBe(false);
    expect(isAdmin({}, { email: "ann@example.com" })).toBe(false);
    expect(isAdmin({ ADMIN_EMAILS: "" }, { email: "" })).toBe(false);
  });
});

describe("checkOverride", () => {
  it("accepts a rename of something in the catalogue, trimmed", () => {
    expect(checkOverride("name", "class:qa_paladin", { name: "  Test Paladin " })).toEqual({ ok: true, value: { name: "Test Paladin" } });
    expect(checkOverride("name", "furnishing:bed", { blurb: "Sleep well." }).ok).toBe(true);
    expect(checkOverride("name", "gear:hauberk", { name: "Mail Shirt" }).ok).toBe(true);
  });
  it("rejects unknown kinds and targets", () => {
    expect(checkOverride("stats", "class:qa_paladin", { name: "X" }).ok).toBe(false);
    expect(checkOverride("name", "class:nobody", { name: "X" }).ok).toBe(false);
    expect(checkOverride("name", "qa_paladin", { name: "X" }).ok).toBe(false);
    expect(checkOverride("name", "class:__proto__", { name: "X" }).ok).toBe(false);
    expect(checkOverride("palette", "dragon", { body: "#ffffff" }).ok).toBe(false);
    expect(checkOverride("icon", "not-an-icon", { png: fakePng(16, 16) }).ok).toBe(false);
  });
  it("limits names and blurbs and refuses control characters and extra fields", () => {
    expect(checkOverride("name", "class:qa_paladin", { name: "x".repeat(33) }).ok).toBe(false);
    expect(checkOverride("name", "class:qa_paladin", { name: "x".repeat(32) }).ok).toBe(true);
    expect(checkOverride("name", "class:qa_paladin", { blurb: "x".repeat(201) }).ok).toBe(false);
    expect(checkOverride("name", "class:qa_paladin", { name: "two\nlines" }).ok).toBe(false);
    expect(checkOverride("name", "class:qa_paladin", { name: "   " }).ok).toBe(false);
    expect(checkOverride("name", "class:qa_paladin", {}).ok).toBe(false);
    expect(checkOverride("name", "class:qa_paladin", { name: "X", hp: 99 }).ok).toBe(false);
    expect(checkOverride("name", "class:qa_paladin", null).ok).toBe(false);
  });
  it("accepts palette colours, hats and weapons from the existing sets only", () => {
    expect(checkOverride("palette", "bandit", { body: "#AABBCC", hat: "horns", weapon: "bow" })).toEqual({
      ok: true,
      value: { body: "#aabbcc", hat: "horns", weapon: "bow" },
    });
    expect(checkOverride("palette", "bandit", { body: "red" }).ok).toBe(false);
    expect(checkOverride("palette", "bandit", { hat: "crown" }).ok).toBe(false);
    expect(checkOverride("palette", "bandit", { weapon: "axe" }).ok).toBe(false);
    expect(checkOverride("palette", "bandit", { speed: 99 }).ok).toBe(false);
    expect(checkOverride("palette", "bandit", {}).ok).toBe(false);
  });
  it("accepts a 16x16 icon and an 18x22 sprite, and nothing else", () => {
    expect(checkOverride("icon", "chest-armor", { png: fakePng(16, 16) }).ok).toBe(true);
    expect(checkOverride("icon", "chest-armor", { png: `data:image/png;base64,${fakePng(16, 16)}` }).ok).toBe(true);
    expect(checkOverride("icon", "chest-armor", { png: fakePng(17, 16) }).ok).toBe(false);
    expect(checkOverride("sprite", "wolf", { png: fakePng(18, 22) }).ok).toBe(true);
    expect(checkOverride("sprite", "qa_paladin", { png: fakePng(16, 16) }).ok).toBe(false);
  });
  it("rejects oversized, non-PNG and malformed images", () => {
    expect(checkOverride("icon", "chest-armor", { png: fakePng(16, 16, PNG_MAX_BYTES + 1) }).ok).toBe(false);
    expect(checkOverride("icon", "chest-armor", { png: Buffer.from("GIF89a-not-a-png-at-all-really").toString("base64") }).ok).toBe(false);
    expect(checkOverride("icon", "chest-armor", { png: "!!!" }).ok).toBe(false);
    expect(checkOverride("icon", "chest-armor", { url: "https://example.com/x.png" }).ok).toBe(false);
  });
});

describe("pngSize", () => {
  it("reads width and height from IHDR", () => {
    expect(pngSize(Buffer.from(fakePng(18, 22), "base64"))).toEqual({ w: 18, h: 22 });
    expect(pngSize(new Uint8Array(10))).toBeNull();
  });
});

describe("checkImport", () => {
  it("checks every entry of an exported bundle", () => {
    const ok = checkImport({ version: 3, names: { "class:qa_paladin": { name: "P" } }, palettes: { bandit: { body: "#000000" } }, icons: {}, sprites: {} });
    expect(ok.ok && ok.items.length).toBe(2);
    expect(checkImport({ names: { "class:nobody": { name: "P" } } }).ok).toBe(false);
    expect(checkImport("nope").ok).toBe(false);
  });
});

describe("the override store", () => {
  let sql: DatabaseSync;
  let db: D1Database;
  beforeEach(() => {
    ({ sql, db } = openDb());
    sql.exec("INSERT INTO players (id, name, created_at, email) VALUES ('ann', 'Ann', 0, 'ann@example.com')");
  });

  it("starts empty at version 0", async () => {
    expect(await contentBundle(db)).toEqual({ version: 0, names: {}, palettes: {}, icons: {}, sprites: {} });
  });

  it("saves, replaces and reverts, bumping the version and keeping history", async () => {
    expect(await putOverride(db, "name", "class:qa_paladin", { name: "Tester" }, "ann")).toBe(1);
    expect(await putOverride(db, "name", "class:qa_paladin", { name: "Tester II" }, "ann")).toBe(2);
    await putOverride(db, "palette", "bandit", { body: "#000000" }, "ann");
    const bundle = await contentBundle(db);
    expect(bundle.version).toBe(3);
    expect(bundle.names).toEqual({ "class:qa_paladin": { name: "Tester II" } });
    expect(bundle.palettes).toEqual({ bandit: { body: "#000000" } });

    expect(await deleteOverride(db, "name", "class:qa_paladin", "ann")).toBe(true);
    expect(await deleteOverride(db, "name", "class:qa_paladin", "ann")).toBe(false);
    expect((await contentBundle(db)).names).toEqual({});
    expect(await contentVersion(db)).toBe(4);

    const history = await overrideHistory(db, "name", "class:qa_paladin");
    expect(history.map((h) => [h.old, h.new])).toEqual([
      [{ name: "Tester II" }, null],
      [{ name: "Tester" }, { name: "Tester II" }],
      [null, { name: "Tester" }],
    ]);
    expect(history[0].by_name).toBe("Ann");
  });

  it("imports many overrides in one version", async () => {
    const v = await putOverrides(
      db,
      [
        { kind: "name", target: "pub:ale", value: { name: "Ale" } },
        { kind: "icon", target: "chest-armor", value: { png: fakePng(16, 16) } },
      ],
      "ann",
    );
    expect(v).toBe(1);
    const bundle = await contentBundle(db);
    expect(Object.keys(bundle.names)).toEqual(["pub:ale"]);
    expect(Object.keys(bundle.icons)).toEqual(["chest-armor"]);
  });
});
