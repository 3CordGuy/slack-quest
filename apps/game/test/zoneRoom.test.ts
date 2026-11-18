// ZoneRoom against a real SQLite database with the game's migrations
// applied, driven with fake hibernatable sockets, as the Harbor's room tests
// are. Covered: a zone is made and walked into, a walk is saved before it
// is told, walking near an enemy group starts a fight with a turn clock,
// the room coming back from hibernation finds the same turn, the clock
// running out ends the turn, and dev actions are refused where they should be.
// Also what the room does for a client that shows its actions ahead of the
// answer: the number an action was sent with comes back to its sender alone,
// on the update or on the refusal, and a client that keeps the map's tiles is
// sent them once.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { hexDistance } from "@gantt-quest/core";
import { ALERT_RANGE, ATLAS_HOME, EXPLORE_ROUND_MS, atlasNodeById, zoneOptions, type ZoneEvent, type ZoneState, type ZoneView } from "@gantt-quest/world";
import { atlasSeed, chartFor, openNode } from "../src/server/atlas";
import { CAVE_IDLE_MS, createZoneRow, crewPlaces, openCave, teleportTo } from "../src/server/zones";

const globals = globalThis as Record<string, unknown>;
globals.WebSocketRequestResponsePair = class {
  constructor(
    public request: string,
    public response: string,
  ) {}
};
/** The client's end of a socket pair is never looked at here; the server's end is taken from `nextServerSocket`. */
let nextServerSocket: FakeSocket;
globals.WebSocketPair = class {
  0 = {};
  1 = nextServerSocket;
};
// Node's Response refuses status 101; the room only needs it to exist.
class Upgrade {
  status = 101;
}
const RealResponse = Response;
globals.Response = function (body: unknown, init?: { status?: number; webSocket?: unknown }) {
  return init?.status === 101 ? new Upgrade() : new RealResponse(body as BodyInit, init);
} as unknown as typeof Response;

const { ZoneRoom, ZONE_TURN_MS, zoneActionFrom } = await import("../src/server/zone-room");

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

type Update = { type: "update"; state: ZoneView; events: ZoneEvent[]; online: string[]; ack?: number } | { type: "error"; message: string; ack?: number };
class FakeSocket {
  sent: Update[] = [];
  closed: number | null = null;
  private attachment: unknown = null;
  deserializeAttachment() {
    return this.attachment;
  }
  serializeAttachment(next: unknown) {
    this.attachment = next;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
  }
  /** The newest state this socket was sent. */
  get state(): ZoneView {
    const last = this.sent.filter((m): m is Extract<Update, { type: "update" }> => m.type === "update").at(-1);
    if (!last) throw new Error("nothing sent yet");
    return last.state;
  }
  get errors(): string[] {
    return this.sent.flatMap((m) => (m.type === "error" ? [m.message] : []));
  }
}

let sql: DatabaseSync;
let db: D1Database;
let sockets: FakeSocket[];
let storage: Map<string, unknown>;
let alarm: number | null;
let environment: string | undefined;

/** A room as the runtime would hand it over: fresh in memory, with whatever sockets and storage outlived the last one. */
function room() {
  const ctx = {
    setWebSocketAutoResponse() {},
    waitUntil() {},
    getWebSockets: (tag?: string) => sockets.filter((s) => s.closed === null && (!tag || (s.deserializeAttachment() as { playerId: string } | null)?.playerId === tag)),
    acceptWebSocket(ws: FakeSocket) {
      sockets.push(ws);
    },
    storage: {
      get: async (key: string) => storage.get(key),
      put: async (key: string, value: unknown) => void storage.set(key, value),
      setAlarm: async (at: number) => void (alarm = at),
      getAlarm: async () => alarm,
      deleteAlarm: async () => void (alarm = null),
    },
  };
  return new ZoneRoom(ctx as never, { DB: db, ENVIRONMENT: environment } as never);
}

async function connect(to: InstanceType<typeof ZoneRoom>, code: string, playerId: string, near?: string, lean = false): Promise<FakeSocket> {
  const ws = new FakeSocket();
  nextServerSocket = ws;
  const res = await to.fetch({ headers: new Headers({ Upgrade: "websocket", "x-zone-code": code, "x-player-id": playerId, ...(near ? { "x-zone-near": near } : {}), ...(lean ? { "x-zone-lean": "1" } : {}) }) } as never);
  if (res.status !== 101) throw new Error(`refused: ${await res.text()}`);
  return ws;
}

const act = (to: InstanceType<typeof ZoneRoom>, ws: FakeSocket, action: Record<string, unknown>, n?: unknown) => to.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "action", action, ...(n !== undefined ? { n } : {}) }));
const saved = (code: string) => JSON.parse((sql.prepare("SELECT state_json FROM zones WHERE code = ?").get(code) as { state_json: string }).state_json) as ZoneState;
const hero = (state: ZoneView | ZoneState, id: string) => state.units.find((u) => u.id === id)!;
const presence = (id: string) => sql.prepare("SELECT code, fighting FROM zone_presence WHERE player_id = ?").get(id) as { code: string; fighting: number } | undefined;

/** A small open map with one pair of wolves on it, and Ann connected. */
async function arrive() {
  const code = await createZoneRow(db, "ann", zoneOptions({ size: "small", biome: "meadow", groups: 1, kinds: ["wolf"], elevation: 0, obstacles: 0, clear: 3, party: 2 }), "room-test");
  const zone = room();
  const ann = await connect(zone, code, "ann");
  return { code, zone, ann };
}

/** Walk Ann toward the wolves until the fight starts. */
async function pickFight(zone: InstanceType<typeof ZoneRoom>, ann: FakeSocket) {
  const wolf = ann.state.units.find((u) => u.side === "enemy")!;
  for (let i = 0; i < 6 && !ann.state.encounter; i++) await act(zone, ann, { type: "move", unit: "ann", to: wolf.pos });
  // A click on the wolf's own hex is refused (it is standing there): aim beside it.
  for (let i = 0; i < 12 && !ann.state.encounter; i++) {
    const me = hero(ann.state, "ann");
    const step = ann.state.map.tiles.filter((t) => hexDistance(t, me.pos) === 1 && t.biome === "plains").sort((a, b) => hexDistance(a, wolf.pos) - hexDistance(b, wolf.pos))[0];
    await act(zone, ann, { type: "move", unit: "ann", to: { q: step.q, r: step.r } });
  }
  expect(ann.state.encounter).not.toBeNull();
}

beforeEach(() => {
  sql = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  db = { prepare: (text: string) => new Stmt(sql, text), batch: async (stmts: Stmt[]) => stmts.map((s) => s.exec()) } as unknown as D1Database;
  const at = Date.now();
  for (const [id, name] of [["ann", "Ann"], ["bo", "Bo"]]) {
    sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(id, name, at);
    sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, 'qa_paladin', 'active', 9, 4, 9, 4, 4, 100, ?)").run(id, name, at);
  }
  sockets = [];
  storage = new Map();
  alarm = null;
  environment = "dev";
});

describe("ZoneRoom", () => {
  it("lets a hero walk in, and saves each walk before it is told", async () => {
    const { code, zone, ann } = await arrive();
    expect(ann.state.you).toBe("ann");
    expect(hero(ann.state, "ann").pos).toEqual(ann.state.start);
    // The dice stay on the server.
    expect(ann.state).not.toHaveProperty("rng");
    expect(ann.state).not.toHaveProperty("seed");
    const to = ann.state.map.tiles.find((t) => hexDistance(t, ann.state.start) === 2 && t.biome === "plains")!;
    await act(zone, ann, { type: "move", unit: "ann", to: { q: to.q, r: to.r } });
    expect(hero(ann.state, "ann").pos).toEqual({ q: to.q, r: to.r });
    expect(hero(saved(code), "ann").pos).toEqual({ q: to.q, r: to.r });
    expect(alarm).toBeNull();
  });

  it("refuses someone with no hero, and replaces an older tab", async () => {
    const { code, zone, ann } = await arrive();
    nextServerSocket = new FakeSocket();
    const res = await zone.fetch({ headers: new Headers({ Upgrade: "websocket", "x-zone-code": code, "x-player-id": "nobody" }) } as never);
    expect(res.status).toBe(409);
    await connect(zone, code, "ann");
    expect(ann.closed).toBe(4000);
  });

  it("shows a second player the first, and tells both when either moves", async () => {
    const { code, zone, ann } = await arrive();
    const bo = await connect(zone, code, "bo");
    expect(bo.state.units.filter((u) => u.side === "hero").map((u) => u.id).sort()).toEqual(["ann", "bo"]);
    expect(hero(bo.state, "bo").pos).not.toEqual(hero(bo.state, "ann").pos);
    const to = bo.state.map.tiles.find((t) => hexDistance(t, bo.state.start) === 3 && t.biome === "plains")!;
    await act(zone, bo, { type: "move", unit: "bo", to: { q: to.q, r: to.r } });
    expect(hero(ann.state, "bo").pos).toEqual({ q: to.q, r: to.r });
    // One player cannot move another's hero.
    await act(zone, bo, { type: "move", unit: "ann", to: { q: to.q, r: to.r } });
    expect(bo.errors.at(-1)).toMatch(/not yours/);
  });

  it("starts a fight with a turn clock when a hero walks within sight of a group", async () => {
    const { code, zone, ann } = await arrive();
    await pickFight(zone, ann);
    const enc = ann.state.encounter!;
    expect(enc.order).toContain("ann");
    expect(Math.min(...ann.state.units.filter((u) => u.side === "enemy").map((u) => hexDistance(u.pos, hero(ann.state, "ann").pos)))).toBeLessThanOrEqual(ALERT_RANGE);
    // Enemy turns are played on the server: whenever the room is waiting, it is waiting on a hero.
    expect(enc.acting).toEqual(["ann"]);
    expect(enc.deadline).toBeGreaterThan(Date.now());
    expect(alarm).toBe(enc.deadline);
    expect((sql.prepare("SELECT status FROM zones WHERE code = ?").get(code) as { status: string }).status).toBe("fight");
  });

  it("finds the same turn again after hibernation, and ends it when the clock runs out", async () => {
    const { code, zone, ann } = await arrive();
    await pickFight(zone, ann);
    const before = ann.state.encounter!;
    // The object is evicted: a new one has only D1, its storage and the sockets.
    const woken = room();
    const again = await connect(woken, code, "ann");
    expect(again.state.encounter).toMatchObject({ turnNo: before.turnNo, acting: before.acting, round: before.round, deadline: before.deadline });
    expect(hero(again.state, "ann").pos).toEqual(hero(ann.state, "ann").pos);
    // Woken early, the alarm only re-arms itself.
    await woken.alarm();
    expect(again.state.encounter?.turnNo ?? -1).toBe(before.turnNo);
    // Once the deadline has passed, the turn ends and the fight moves on.
    const state = saved(code);
    state.encounter!.deadline = Date.now() - 1000;
    sql.prepare("UPDATE zones SET state_json = ? WHERE code = ?").run(JSON.stringify(state), code);
    // (A hero reconnecting to an empty zone restarts a lapsed clock; here the socket never went away.)
    const late = room();
    await late.alarm();
    const now = again.state.encounter;
    expect(now === null || now.turnNo > before.turnNo).toBe(true);
    if (now) expect(now.deadline! - Date.now()).toBeGreaterThan(ZONE_TURN_MS - 5000);
  });

  it("writes down who is on the zone and whether they are fighting, and rubs it out when they leave", async () => {
    const { code, zone, ann } = await arrive();
    expect(presence("ann")).toEqual({ code, fighting: 0 });
    await pickFight(zone, ann);
    expect(presence("ann")).toEqual({ code, fighting: 1 });
    // The crew's roster reads the same rows.
    sql.prepare("INSERT INTO crews (id, name, created_by, created_at) VALUES ('CREWAA', 'Crew', 'ann', 1)").run();
    for (const id of ["ann", "bo"]) sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES ('CREWAA', ?, 1)").run(id);
    expect(await crewPlaces(db, "CREWAA")).toEqual([
      { id: "ann", name: "Ann", classId: "qa_paladin", level: 1, zone: { code, fighting: true } },
      { id: "bo", name: "Bo", classId: "qa_paladin", level: 1, zone: null },
    ]);
    await act(zone, ann, { type: "dev", dev: { op: "end_fight" } });
    expect(presence("ann")).toEqual({ code, fighting: 0 });
    ann.close();
    await zone.webSocketClose(ann as unknown as WebSocket, 1000);
    expect(presence("ann")).toBeUndefined();
  });

  it("marks a hero whose player has left the map as away, so nothing pulls them into a fight, and not once they are back", async () => {
    const { code, zone, ann } = await arrive();
    expect(hero(saved(code), "ann").away).toBeUndefined();
    ann.close();
    await zone.webSocketClose(ann as unknown as WebSocket, 1000);
    expect(hero(saved(code), "ann").away).toBe(true);
    expect(presence("ann")).toBeUndefined();
    const again = await connect(zone, code, "ann");
    expect(hero(again.state, "ann").away).toBeUndefined();
    expect(hero(saved(code), "ann").away).toBeUndefined();
  });

  it("sends nobody to a crewmate from the middle of their own fight, or into someone else's", () => {
    const place = (id: string, zone: { code: string; fighting: boolean } | null) => ({ id, name: id.toUpperCase(), classId: "qa_paladin", level: 1, zone });
    expect(teleportTo([place("ann", { code: "AAAA", fighting: false }), place("bo", { code: "BBBB", fighting: false })], "ann", "bo")).toEqual({ zone: "BBBB", name: "BO" });
    expect(teleportTo([place("ann", { code: "AAAA", fighting: true }), place("bo", { code: "BBBB", fighting: false })], "ann", "bo")).toMatchObject({ status: 409, error: expect.stringMatching(/flee it first/) });
    expect(teleportTo([place("ann", { code: "AAAA", fighting: true }), place("bo", null)], "ann", "bo")).toMatchObject({ status: 409 });
    expect(teleportTo([place("ann", null), place("bo", { code: "BBBB", fighting: true })], "ann", "bo")).toMatchObject({ status: 409, error: expect.stringMatching(/BO is in a fight/) });
    expect(teleportTo([place("ann", null)], "ann", "ann")).toMatchObject({ status: 400 });
  });

  it("puts someone who teleports to a crewmate beside them, unless that crewmate is in a fight", async () => {
    const { code, zone, ann } = await arrive();
    const far = ann.state.map.tiles.find((t) => hexDistance(t, ann.state.start) === 3 && t.biome === "plains")!;
    await act(zone, ann, { type: "move", unit: "ann", to: { q: far.q, r: far.r } });
    const bo = await connect(zone, code, "bo", "ann");
    expect(hexDistance(hero(bo.state, "bo").pos, hero(bo.state, "ann").pos)).toBe(1);
    // In a fight, a newcomer arrives at the map's start instead.
    sql.prepare("INSERT INTO players (id, name, created_at) VALUES ('cy', 'Cy', 1)").run();
    sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES ('cy', 'Cy', 'qa_paladin', 'active', 9, 4, 9, 4, 4, 100, 1)").run();
    await act(zone, ann, { type: "dev", dev: { op: "ai", off: true } });
    await act(zone, ann, { type: "dev", dev: { op: "start_fight" } });
    expect(ann.state.encounter?.order).toContain("ann");
    const cy = await connect(zone, code, "cy", "ann");
    expect(hexDistance(hero(cy.state, "cy").pos, cy.state.start)).toBeLessThanOrEqual(1);
  });

  it("reads a hero again when their gear changes, but leaves them as they were in a fight", async () => {
    const { zone, ann } = await arrive();
    const sheet = () => zone.webSocketMessage(ann as unknown as WebSocket, JSON.stringify({ type: "sheet" }));
    const was = hero(ann.state, "ann").maxHp;
    sql.prepare("UPDATE characters SET vit = vit + 6 WHERE player_id = 'ann'").run();
    await sheet();
    const grown = hero(ann.state, "ann").maxHp;
    expect(grown).toBeGreaterThan(was);

    await pickFight(zone, ann);
    sql.prepare("UPDATE characters SET vit = vit + 6 WHERE player_id = 'ann'").run();
    await sheet();
    expect(hero(ann.state, "ann").maxHp).toBe(grown);
  });

  it("carries what the hero's pack holds, and takes each one used out of the pack", async () => {
    const stock = (qty: number) => sql.prepare("INSERT INTO consumables (player_id, kind, qty) VALUES ('ann', 'healing', ?) ON CONFLICT(player_id, kind) DO UPDATE SET qty = excluded.qty").run(qty);
    const inPack = () => (sql.prepare("SELECT qty FROM consumables WHERE player_id = 'ann' AND kind = 'healing'").get() as { qty: number }).qty;
    stock(3);
    const { code, zone, ann } = await arrive();
    expect(hero(ann.state, "ann").items).toEqual({ healing: 3 });

    await act(zone, ann, { type: "drink", unit: "ann", item: "healing" });
    expect(ann.errors).toEqual([]);
    expect(hero(ann.state, "ann").items.healing).toBe(2);
    expect(inPack()).toBe(2);
    expect(hero(saved(code), "ann").items.healing).toBe(2);

    // The pack changed elsewhere: the next one used is counted from what is really there.
    stock(1);
    await act(zone, ann, { type: "throw", unit: "ann", item: "healing", at: hero(ann.state, "ann").pos });
    expect(inPack()).toBe(0);
    expect(hero(ann.state, "ann").items.healing ?? 0).toBe(0);

    // None left: refused, and nothing goes below nothing.
    await act(zone, ann, { type: "drink", unit: "ann", item: "healing" });
    expect(ann.errors.length).toBe(1);
    expect(inPack()).toBe(0);

    // The dev restock fills the pack itself, so it is still there on the next map.
    await act(zone, ann, { type: "dev", dev: { op: "heal" } });
    expect(inPack()).toBe(2);
    expect(hero(ann.state, "ann").items).toEqual({ healing: 2, poison: 2, fire: 1, oil: 1, water: 1, torch: 2 });
  });

  it("pays a won fight's XP and materials to the hero, and marks a map with no enemy left as cleared", async () => {
    const { code, zone, ann } = await arrive();
    const xpBefore = (sql.prepare("SELECT xp, level FROM characters WHERE player_id = 'ann'").get() as { xp: number; level: number });
    await pickFight(zone, ann);
    await act(zone, ann, { type: "dev", dev: { op: "end_fight" } });
    const spoils = ann.sent.flatMap((m) => (m.type === "update" ? m.events : [])).find((e) => e.t === "spoils");
    expect(spoils).toMatchObject({ t: "spoils", id: "ann" });
    const paid = spoils as Extract<ZoneEvent, { t: "spoils" }>;
    expect(paid.xp).toBeGreaterThan(0);
    const after = sql.prepare("SELECT xp, level FROM characters WHERE player_id = 'ann'").get() as { xp: number; level: number };
    expect(after.level > xpBefore.level || after.xp === xpBefore.xp + paid.xp).toBe(true);
    // Wolves leave fur and bone, and they are in the hut's materials.
    const held = Object.fromEntries((sql.prepare("SELECT kind, qty FROM resources WHERE player_id = 'ann'").all() as { kind: string; qty: number }[]).map((r) => [r.kind, r.qty]));
    expect(held).toEqual(paid.resources);
    expect((sql.prepare("SELECT status FROM zones WHERE code = ?").get(code) as { status: string }).status).toBe("cleared");
  });

  it("pays a delve's chests into the character, and calls the delve cleared only once its foes are gone and its chests open", async () => {
    const code = await createZoneRow(db, "ann", zoneOptions({ biome: "caves", delve: true, party: 1 }), "room-delve", "caves", "crew1");
    let zone = room();
    await connect(zone, code, "ann");
    // Nobody left below but Ann, standing beside the first chest.
    const state = saved(code);
    const chests = state.map.pois.filter((p) => p.kind === "cache");
    expect(chests.length).toBeGreaterThan(1);
    const besideOf = (c: { pos: { q: number; r: number } }) => state.map.tiles.find((t) => t.biome === "cave" && hexDistance(t, c.pos) === 1)!;
    state.units = state.units.filter((u) => u.side === "hero");
    const b = besideOf(chests[0]);
    hero(state, "ann").pos = { q: b.q, r: b.r };
    sql.prepare("UPDATE zones SET state_json = ? WHERE code = ?").run(JSON.stringify(state), code);
    zone = room();
    const ann = await connect(zone, code, "ann");
    const goldBefore = (sql.prepare("SELECT gold FROM characters WHERE player_id = 'ann'").get() as { gold: number }).gold;
    await act(zone, ann, { type: "open", unit: "ann", poi: chests[0].id });
    expect(ann.errors).toEqual([]);
    const spoils = ann.sent.flatMap((m) => (m.type === "update" ? m.events : [])).find((e) => e.t === "spoils") as Extract<ZoneEvent, { t: "spoils" }>;
    expect(spoils.gold).toBeGreaterThan(0);
    expect((sql.prepare("SELECT gold FROM characters WHERE player_id = 'ann'").get() as { gold: number }).gold).toBe(goldBefore + spoils.gold!);
    if (spoils.potions) expect((sql.prepare("SELECT qty FROM consumables WHERE player_id = 'ann' AND kind = 'healing'").get() as { qty: number }).qty).toBeGreaterThanOrEqual(spoils.potions);
    if (spoils.item) expect(sql.prepare("SELECT name FROM inventory WHERE player_id = 'ann'").all().map((r) => (r as { name: string }).name)).toContain(spoils.item);
    // No foes left, but chests still shut: not cleared, and the crew's cave is still there to go back to.
    const status = () => (sql.prepare("SELECT status FROM zones WHERE code = ?").get(code) as { status: string }).status;
    expect(status()).toBe("open");
    expect(await openCave(db, "crew1")).toBe(code);
    // Every chest opened: cleared.
    for (const c of chests.slice(1)) {
      const now = saved(code);
      const at = besideOf(c);
      hero(now, "ann").pos = { q: at.q, r: at.r };
      sql.prepare("UPDATE zones SET state_json = ? WHERE code = ?").run(JSON.stringify(now), code);
      zone = room();
      const again = await connect(zone, code, "ann");
      await act(zone, again, { type: "open", unit: "ann", poi: c.id });
      expect(again.errors).toEqual([]);
    }
    expect(status()).toBe("cleared");
    expect(await openCave(db, "crew1")).toBeNull();
  });

  it("finds a crew's cave still being fought through, and not a cleared, stale or other crew's one", async () => {
    const options = zoneOptions({ size: "small", biome: "caves", groups: 1 });
    expect(await openCave(db, "crew1")).toBeNull();
    const cave = await createZoneRow(db, "ann", options, "c1", "caves", "crew1");
    await createZoneRow(db, "ann", options, "d1", "dev", "crew1");
    expect(await openCave(db, "crew1")).toBe(cave);
    expect(await openCave(db, "crew2")).toBeNull();
    sql.prepare("UPDATE zones SET status = 'cleared' WHERE code = ?").run(cave);
    expect(await openCave(db, "crew1")).toBeNull();
    const stale = await createZoneRow(db, "ann", options, "c2", "caves", "crew1");
    sql.prepare("UPDATE zones SET updated_at = ? WHERE code = ?").run(Date.now() - CAVE_IDLE_MS - 1000, stale);
    expect(await openCave(db, "crew1")).toBeNull();
  });

  it("lets time out of a fight pass with whatever is done next, and tells it", async () => {
    const clock = vi.spyOn(Date, "now");
    try {
      const T0 = 2_000_000_000_000;
      clock.mockReturnValue(T0);
      const { code, zone, ann } = await arrive();
      const at = ann.state.map.tiles.find((t) => hexDistance(t, ann.state.start) === 2 && t.biome === "plains")!;
      await act(zone, ann, { type: "dev", dev: { op: "paint", kind: "oil", hexes: [{ q: at.q, r: at.r }] } });
      const rounds = saved(code).surfaces[`${at.q},${at.r}`].rounds;
      // Three rounds of exploring later, the next thing done counts them.
      clock.mockReturnValue(T0 + 3 * EXPLORE_ROUND_MS + 500);
      const before = ann.sent.length;
      const step = ann.state.map.tiles.find((t) => hexDistance(t, ann.state.start) === 1 && t.biome === "plains")!;
      await act(zone, ann, { type: "move", unit: "ann", to: { q: step.q, r: step.r } });
      expect(saved(code).surfaces[`${at.q},${at.r}`].rounds).toBe(rounds - 3);
      expect(saved(code).clock!.at).toBe(T0 + 3 * EXPLORE_ROUND_MS);
      expect(ann.sent.length).toBeGreaterThan(before);
    } finally {
      clock.mockRestore();
    }
  });

  it("puts a torch picked up with one already in hand into the pack, for good", async () => {
    const { code, zone, ann } = await arrive();
    const state = saved(code);
    const me = hero(state, "ann");
    me.torch = 5;
    const beside = state.map.tiles.find((t) => hexDistance(t, me.pos) === 1 && t.biome === "plains")!;
    state.lights = { [`${beside.q},${beside.r}`]: { rounds: 3, by: null } };
    sql.prepare("UPDATE zones SET state_json = ? WHERE code = ?").run(JSON.stringify(state), code);
    const again = room();
    const sock = await connect(again, code, "ann");
    const inPack = () => (sql.prepare("SELECT qty FROM consumables WHERE player_id = 'ann' AND kind = 'torch'").get() as { qty: number } | undefined)?.qty ?? 0;
    const had = inPack();
    await act(again, sock, { type: "pickup", unit: "ann", at: { q: beside.q, r: beside.r } });
    expect(sock.errors).toEqual([]);
    expect(inPack()).toBe(had + 1);
    expect(hero(saved(code), "ann").torch).toBe(5);
    expect(zone).toBeDefined();
    expect(ann).toBeDefined();
  });

  it("gives a cave saved without a mouth one as it is loaded, so it can be left", async () => {
    const code = await createZoneRow(db, "ann", zoneOptions({ biome: "caves", size: "small", groups: 1 }), "old-cave", "caves", "crew1");
    await connect(room(), code, "ann");
    const state = saved(code);
    state.map.pois = [];
    sql.prepare("UPDATE zones SET state_json = ? WHERE code = ?").run(JSON.stringify(state), code);
    const ann = await connect(room(), code, "ann");
    expect(ann.state.map.pois.filter((p) => p.kind === "landing").map((p) => p.pos)).toEqual([ann.state.start]);
    expect(saved(code).map.pois.some((p) => p.kind === "landing")).toBe(true);
  });

  it("tells a player on the map, and only that player, that their trades changed", async () => {
    const { code, zone, ann } = await arrive();
    const bo = await connect(zone, code, "bo");
    const before = [ann.sent.length, bo.sent.length];
    const res = await zone.fetch({ url: "https://zone/trades?to=bo", headers: new Headers() } as never);
    expect(res.status).toBe(200);
    expect(bo.sent.slice(before[1])).toEqual([{ type: "trades" }]);
    expect(ann.sent.length).toBe(before[0]);
  });

  it("marks a landfall cleared on the crew's chart when its map is, once, and opens the ones beyond it", async () => {
    const at = Date.now();
    sql.prepare("INSERT INTO crews (id, name, created_by, created_at) VALUES ('CREWAA', 'Crew', 'ann', ?)").run(at);
    sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES ('CREWAA', 'ann', ?)").run(at);
    const node = atlasNodeById(atlasSeed("CREWAA"), ATLAS_HOME)!.links[0];
    const went = await openNode(db, "CREWAA", "ann", node, 1);
    if ("error" in went) throw new Error(went.error);
    const status = () => (sql.prepare("SELECT status FROM atlas_nodes WHERE crew_id = 'CREWAA' AND node = ?").get(node) as { status: string }).status;
    const zone = room();
    const ann = await connect(zone, went.code, "ann");
    expect(ann.state.options).toMatchObject({ tier: 1, name: atlasNodeById(atlasSeed("CREWAA"), node)!.name });
    expect(status()).toBe("open");

    // Every band on it beaten, one fight at a time.
    for (let i = 0; i < 8 && ann.state.units.some((u) => u.side === "enemy"); i++) {
      await act(zone, ann, { type: "dev", dev: { op: "start_fight" } });
      await act(zone, ann, { type: "dev", dev: { op: "end_fight" } });
    }
    expect(ann.state.units.some((u) => u.side === "enemy")).toBe(false);
    expect(status()).toBe("cleared");
    expect(ann.state.bounty).toBe(true);
    expect(ann.sent.some((m) => m.type === "update" && m.events.some((e) => e.t === "bounty"))).toBe(true);
    const chart = await chartFor(db, "CREWAA");
    expect(chart.nodes.find((n) => n.id === node)!.state).toBe("cleared");
    expect(chart.nodes.filter((n) => n.state === "open").length).toBeGreaterThanOrEqual(5);

    // A room woken afresh on the same map knows it has been told.
    const clearedAt = () => (sql.prepare("SELECT cleared_at FROM atlas_nodes WHERE crew_id = 'CREWAA' AND node = ?").get(node) as { cleared_at: number }).cleared_at;
    const was = clearedAt();
    const again = room();
    const back = await connect(again, went.code, "ann");
    await act(again, back, { type: "dev", dev: { op: "heal" } });
    expect(clearedAt()).toBe(was);
  });

  it("takes dev actions on a development deployment only", async () => {
    const { zone, ann } = await arrive();
    const at = ann.state.map.tiles.find((t) => hexDistance(t, ann.state.start) === 1 && t.biome === "plains")!;
    await act(zone, ann, { type: "dev", dev: { op: "paint", kind: "fire", hexes: [{ q: at.q, r: at.r }] } });
    expect(Object.values(ann.state.surfaces).map((s) => s.kind)).toEqual(["fire"]);
    expect(zoneActionFrom({ type: "dev", dev: { op: "heal" } }, "ann", false)).toBeNull();
    expect(zoneActionFrom({ type: "dev", dev: { op: "heal" } }, "ann", true)).toEqual({ type: "dev", by: "ann", dev: { op: "heal" } });
    expect(zoneActionFrom({ type: "dev", dev: { op: "kit", unit: "ann", classId: "devops_mage", weapon: "tome", level: "7", abilities: ["tidal_wave", 3] } }, "ann", true)).toEqual({
      type: "dev", by: "ann", dev: { op: "kit", unit: "ann", classId: "devops_mage", weapon: "tome", level: 7, abilities: ["tidal_wave"] },
    });
    expect(zoneActionFrom({ type: "dev", dev: { op: "kit", unit: "ann", classId: "devops_mage", weapon: "tome", level: 7, abilities: [] } }, "ann", false)).toBeNull();
  });

  it("sends an action's number back to whoever sent it, and to nobody else, on the update that answers it", async () => {
    const { code, zone, ann } = await arrive();
    const bo = await connect(zone, code, "bo");
    const to = ann.state.map.tiles.find((t) => hexDistance(t, hero(ann.state, "ann").pos) === 2 && t.biome === "plains" && !ann.state.units.some((u) => u.pos.q === t.q && u.pos.r === t.r))!;
    await act(zone, ann, { type: "move", unit: "ann", to: { q: to.q, r: to.r } }, 7);
    // (Every update says the room answers numbers, so a client knows it may show its actions ahead.)
    expect(ann.sent.at(-1)).toMatchObject({ type: "update", ack: 7, acks: true });
    expect(bo.sent.at(-1)).toMatchObject({ type: "update" });
    expect(bo.sent.at(-1)).not.toHaveProperty("ack");
    // Both were told the same walk, in the same update.
    expect(hero(bo.state, "ann").pos).toEqual({ q: to.q, r: to.r });
    // An action sent with no number is answered with none, as it always was.
    await act(zone, ann, { type: "move", unit: "ann", to: ann.state.start });
    expect(ann.sent.at(-1)).not.toHaveProperty("ack");
  });

  it("sends the number back on a refusal too, and for something that is not an action at all", async () => {
    const { zone, ann } = await arrive();
    const before = ann.sent.length;
    // Off the map: nowhere to walk to.
    await act(zone, ann, { type: "move", unit: "ann", to: { q: 500, r: 500 } }, 3);
    expect(ann.sent.at(-1)).toEqual({ type: "error", message: "You cannot get there.", ack: 3 });
    // (The clock may be told on the way, as an update of its own: that one answers nothing.)
    for (const m of ann.sent.slice(before, -1)) expect(m).not.toHaveProperty("ack");
    await act(zone, ann, { type: "move", unit: "ann", to: "over there" }, 4);
    expect(ann.sent.at(-1)).toEqual({ type: "error", message: "That could not be done.", ack: 4 });
    // A number that is not one is not sent back; nor is anything, for a misshapen action with no number.
    const quiet = ann.sent.length;
    await act(zone, ann, { type: "move", unit: "ann", to: "over there" });
    expect(ann.sent.length).toBe(quiet);
    await act(zone, ann, { type: "move", unit: "ann", to: { q: 500, r: 500 } }, "9");
    expect(ann.sent.at(-1)).toEqual({ type: "error", message: "You cannot get there." });
  });

  it("sends a map's tiles once to a client that keeps them, and every time to one that does not", async () => {
    const { code, zone, ann } = await arrive();
    const bo = await connect(zone, code, "bo", undefined, true);
    // The first thing a keeping client is sent has the tiles; Ann, who never said she keeps them, has them every time.
    expect(bo.sent[0]).toMatchObject({ type: "update" });
    expect(bo.state.map.tiles.length).toBe(ann.state.map.tiles.length);
    const to = ann.state.map.tiles.find((t) => hexDistance(t, hero(ann.state, "ann").pos) === 1 && t.biome === "plains" && !ann.state.units.some((u) => u.pos.q === t.q && u.pos.r === t.r))!;
    await act(zone, ann, { type: "move", unit: "ann", to: { q: to.q, r: to.r } });
    expect(ann.state.map.tiles.length).toBeGreaterThan(0);
    expect(bo.state.map).not.toHaveProperty("tiles");
    // Everything else about the map still comes: its grid and its places.
    expect(bo.state.map.grid).toEqual(ann.state.map.grid);
    expect(bo.state.map.pois).toEqual(ann.state.map.pois);
    expect(hero(bo.state, "ann").pos).toEqual({ q: to.q, r: to.r });
    // A room back from hibernation still knows: that the tiles were sent is written on the socket, not kept in its memory.
    const woken = room();
    await act(woken, ann, { type: "move", unit: "ann", to: ann.state.start });
    expect(bo.state.map).not.toHaveProperty("tiles");
    expect(ann.state.map.tiles.length).toBeGreaterThan(0);
    // And a new connection is a new socket: it starts with the tiles.
    const again = await connect(woken, code, "bo", undefined, true);
    expect(again.sent[0]).toMatchObject({ type: "update" });
    expect(again.state.map.tiles.length).toBe(ann.state.map.tiles.length);
  });

  it("drops anything misshapen, and never takes the sender's word for who they are", () => {
    expect(zoneActionFrom({ type: "move", unit: "ann", to: { q: "1", r: 2 } }, "ann", true)).toBeNull();
    expect(zoneActionFrom({ type: "join", hero: {} }, "ann", true)).toBeNull();
    expect(zoneActionFrom({ type: "timeout" }, "ann", true)).toBeNull();
    expect(zoneActionFrom({ type: "away", player: "bo", away: true }, "ann", true)).toBeNull();
    expect(zoneActionFrom({ type: "move", by: "bo", unit: "ann", to: { q: 1, r: 2, extra: true } }, "ann", true)).toEqual({ type: "move", by: "ann", unit: "ann", to: { q: 1, r: 2 } });
    expect(zoneActionFrom("move", "ann", true)).toBeNull();
  });
});
