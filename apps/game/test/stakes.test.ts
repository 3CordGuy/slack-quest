// Table stakes on the server, against a real SQLite database with the game's
// migrations applied (the stand-in for D1 in d1.ts): a table
// opens free or at any whole stake up to STAKE_MAX, a free game moves no gold
// at the start or the end, and a stake the seats cannot cover is refused.

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { STAKE_MAX, diceSplit, type DiceRequest, type HarborPlayer } from "@gantt-quest/world";
import type { Env } from "../src/server/db";
import { DICE_RULES, StakeTable } from "../src/server/stake-table";
import { addHero, openDb } from "./d1";

let sql: DatabaseSync;
let db: D1Database;

const addPlayer = (id: string, name: string, gold: number) => addHero(sql, { id, name, classId: "cleric", gold, at: 0 });
const gold = (id: string) => (sql.prepare("SELECT gold FROM characters WHERE player_id = ?").get(id) as { gold: number }).gold;
/** Harbor XP used today, or 0 with no record. */
const harborXp = (id: string) => (sql.prepare("SELECT used FROM harbor_xp WHERE player_id = ?").get(id) as { used: number } | undefined)?.used ?? 0;

beforeEach(() => {
  ({ sql, db } = openDb());
  addPlayer("ann", "Ann", 0);
  addPlayer("bob", "Bob", 1500);
});

/** A dice table with Ann and Bob standing at it; `walk` moves Bob away, which forfeits his seat mid-game. */
function room() {
  const at = DICE_RULES.spot;
  const players: HarborPlayer[] = [
    { id: "ann", name: "Ann", classId: "cleric", level: 1, pos: at },
    { id: "bob", name: "Bob", classId: "cleric", level: 1, pos: at },
  ];
  const store = new Map<string, unknown>();
  const sockets = players.map((p, i) => ({
    tag: p.id,
    sent: [] as { type: string; text?: string; table?: { phase: string; ante: number; pot: number; winner: string | null } | null }[],
    deserializeAttachment: () => players[i],
    serializeAttachment() {},
    send(m: string) {
      this.sent.push(JSON.parse(m));
    },
  }));
  const ctx = {
    storage: { get: async (k: string) => store.get(k), put: async (k: string, v: unknown) => void store.set(k, v), delete: async (k: string) => void store.delete(k) },
    getWebSockets: (tag?: string) => sockets.filter((s) => !tag || s.tag === tag),
  } as unknown as DurableObjectState;
  const table = new StakeTable<Parameters<typeof DICE_RULES.view>[0], DiceRequest>(ctx, { DB: db } as Env, DICE_RULES);
  const ws = sockets as unknown as WebSocket[];
  const ask = (who: 0 | 1, request: DiceRequest) => table.handle(ws[who], players[who], request);
  const last = (who: 0 | 1) => sockets[who].sent.at(-1)!;
  const walk = async () => {
    players[1] = { ...players[1], pos: { q: at.q + 1, r: at.r } };
    await table.reconcile();
  };
  return { ask, last, walk };
}

describe("table stakes on the server", () => {
  it("plays a free game with no gold and no Harbor XP, start to finish", async () => {
    const t = room();
    await t.ask(0, { type: "open", ante: 0 });
    await t.ask(1, { type: "sit" });
    await t.ask(0, { type: "start" });
    expect(t.last(0).table).toMatchObject({ phase: "playing", ante: 0, pot: 0 });
    await t.walk();
    expect(t.last(0).table).toMatchObject({ phase: "done", winner: "ann" });
    expect([gold("ann"), gold("bob")]).toEqual([0, 1500]);
    expect(harborXp("ann")).toBe(0);
  });

  it("opens at any whole stake up to the most, and pays the pot less the house's cut", async () => {
    sql.prepare("UPDATE characters SET gold = 100 WHERE player_id = 'ann'").run();
    const t = room();
    await t.ask(1, { type: "open", ante: 37 });
    await t.ask(0, { type: "sit" });
    await t.ask(1, { type: "start" });
    expect([gold("ann"), gold("bob")]).toEqual([63, 1463]);
    // Bob walks off and forfeits: Ann takes the pot.
    await t.walk();
    expect(t.last(0).table).toMatchObject({ phase: "done", winner: "ann" });
    expect(gold("ann")).toBe(63 + diceSplit(74).prize);
    // A staked win still gives the usual Harbor XP.
    expect(harborXp("ann")).toBeGreaterThan(0);
  });

  it("refuses a stake that is not a whole number from 0 to the most, or that the opener cannot cover", async () => {
    const t = room();
    for (const ante of [-1, 2.5, STAKE_MAX + 1, "10" as unknown as number]) {
      await t.ask(1, { type: "open", ante });
      expect(t.last(1)).toMatchObject({ type: "diceError", text: `Pick a stake: free, or a whole number of gold up to ${STAKE_MAX}.` });
    }
    await t.ask(0, { type: "open", ante: 1 });
    expect(t.last(0)).toMatchObject({ type: "diceError", text: "You cannot afford that ante." });
    await t.ask(1, { type: "open", ante: STAKE_MAX });
    expect(t.last(1).table).toMatchObject({ phase: "open", ante: STAKE_MAX });
    // Ann has nothing: she can sit at a free table but not at this one.
    await t.ask(0, { type: "sit" });
    expect(t.last(0)).toMatchObject({ type: "diceError", text: "You cannot afford the ante." });
  });
});
