// ZoneRoom against a real SQLite database with the game's migrations
// applied, driven with fake hibernatable sockets, as the Harbor's room tests
// are. Covered: a zone is made and walked into, a walk is saved before it
// is told, walking near an enemy group starts a fight with a turn clock,
// the room coming back from hibernation finds the same turn, the clock
// running out ends the turn, and dev actions are refused where they should be.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { hexDistance } from "@gantt-quest/core";
import { ALERT_RANGE, zoneOptions, type ZoneEvent, type ZoneState, type ZoneView } from "@gantt-quest/world";
import { createZoneRow, crewPlaces } from "../src/server/zones";

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

type Update = { type: "update"; state: ZoneView; events: ZoneEvent[]; online: string[] } | { type: "error"; message: string };
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

async function connect(to: InstanceType<typeof ZoneRoom>, code: string, playerId: string, near?: string): Promise<FakeSocket> {
  const ws = new FakeSocket();
  nextServerSocket = ws;
  const res = await to.fetch({ headers: new Headers({ Upgrade: "websocket", "x-zone-code": code, "x-player-id": playerId, ...(near ? { "x-zone-near": near } : {}) }) } as never);
  if (res.status !== 101) throw new Error(`refused: ${await res.text()}`);
  return ws;
}

const act = (to: InstanceType<typeof ZoneRoom>, ws: FakeSocket, action: Record<string, unknown>) => to.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "action", action }));
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
  db = { prepare: (text: string) => new Stmt(sql, text) } as unknown as D1Database;
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

  it("takes dev actions on a development deployment only", async () => {
    const { zone, ann } = await arrive();
    const at = ann.state.map.tiles.find((t) => hexDistance(t, ann.state.start) === 1 && t.biome === "plains")!;
    await act(zone, ann, { type: "dev", dev: { op: "paint", kind: "fire", hexes: [{ q: at.q, r: at.r }] } });
    expect(Object.values(ann.state.surfaces).map((s) => s.kind)).toEqual(["fire"]);
    expect(zoneActionFrom({ type: "dev", dev: { op: "heal" } }, "ann", false)).toBeNull();
    expect(zoneActionFrom({ type: "dev", dev: { op: "heal" } }, "ann", true)).toEqual({ type: "dev", by: "ann", dev: { op: "heal" } });
  });

  it("drops anything misshapen, and never takes the sender's word for who they are", () => {
    expect(zoneActionFrom({ type: "move", unit: "ann", to: { q: "1", r: 2 } }, "ann", true)).toBeNull();
    expect(zoneActionFrom({ type: "join", hero: {} }, "ann", true)).toBeNull();
    expect(zoneActionFrom({ type: "timeout" }, "ann", true)).toBeNull();
    expect(zoneActionFrom({ type: "move", by: "bo", unit: "ann", to: { q: 1, r: 2, extra: true } }, "ann", true)).toEqual({ type: "move", by: "ann", unit: "ann", to: { q: 1, r: 2 } });
    expect(zoneActionFrom("move", "ann", true)).toBeNull();
  });
});
