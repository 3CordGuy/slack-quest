// Renaming a hero from their sheet, against a real SQLite database with the game's migrations applied
// (the stand-in for D1 in d1.ts).

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanHeroName, renameCharacter } from "../src/server/db";
import { addHero, openDb } from "./d1";

let sql: DatabaseSync;
let db: D1Database;
const nameOf = (id: string) => (sql.prepare("SELECT name FROM characters WHERE player_id = ?").get(id) as { name: string }).name;

beforeEach(() => {
  ({ sql, db } = openDb());
  const at = Date.now();
  for (const [id, name, status] of [["ann", "Ann", "active"], ["bob", "Bob", "active"], ["cat", "Cat", "draft"]] as const) addHero(sql, { id, name, status, gold: 0, at });
});

describe("cleanHeroName", () => {
  it("tidies spaces and keeps 2 to 20 characters", () => {
    expect(cleanHeroName("  Salt   Annie ")).toBe("Salt Annie");
    expect(cleanHeroName("A")).toBeNull();
    expect(cleanHeroName("x".repeat(21))).toBeNull();
    expect(cleanHeroName(undefined)).toBeNull();
  });
});

describe("renameCharacter", () => {
  it("renames your own hero", async () => {
    expect(await renameCharacter(db, "ann", "Salt Annie")).toBeNull();
    expect(nameOf("ann")).toBe("Salt Annie");
  });

  it("refuses another hero's name in any case, but lets you change your own capitals", async () => {
    expect(await renameCharacter(db, "ann", "BOB")).toMatch(/already/);
    expect(nameOf("ann")).toBe("Ann");
    expect(await renameCharacter(db, "ann", "ANN")).toBeNull();
    expect(nameOf("ann")).toBe("ANN");
  });

  it("does not rename a hero still being made", async () => {
    expect(await renameCharacter(db, "cat", "Kit")).toMatch(/No hero/);
    expect(nameOf("cat")).toBe("Cat");
  });
});
