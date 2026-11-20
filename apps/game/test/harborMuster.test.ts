// The crew's muster as the Harbor room keeps it (src/server/harbor-room.ts; the rules are packages/world/src/
// muster.ts, with tests of their own). The room is driven the way the worker drives it (the internal /muster
// routes, with what `scoutNode` said of the place), with fake hibernatable sockets as in the other Harbor room
// tests, a fake of the object's storage and its alarm, and a real SQLite database with the game's migrations
// applied (the same stand-in for D1 as atlas.test.ts), so the map a muster makes is really made.

import { readFileSync, readdirSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ATLAS_HOME, HARBOR_SPAWN, MUSTER_LINGER_MS, MUSTER_MS, MUSTER_PARTY, atlasNodeById, needsStone, stoneItem, type HarborPlayer, type HarborServerMessage, type Muster, type MusterAnswer, type MusterMember, type ZoneMod, type ZoneOptions } from "@gantt-quest/world";
import { atlasSeed, chartFor, clearNode, openNode, scoutNode } from "../src/server/atlas";
import { lodestonesOf } from "../src/server/lodestones";
import { CAVE_IDLE_MS, getZoneRow } from "../src/server/zones";

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
// Node's Response refuses status 101; the room only needs the answer to an upgrade to exist.
const RealResponse = Response;
globals.Response = Object.assign(
  function (body: unknown, init?: { status?: number; webSocket?: unknown }) {
    return init?.status === 101 ? { status: 101 } : new RealResponse(body as BodyInit, init);
  },
  { json: (data: unknown, init?: ResponseInit) => RealResponse.json(data, init) },
) as unknown as typeof Response;

const { HarborRoom } = await import("../src/server/harbor-room");

type Row = Record<string, unknown>;
/**
 * Whether the database takes a turn of the event loop to answer, as D1 does (it is over the network; the object's
 * own storage is not). Off, a whole request runs to its end before the next is looked at; on, two requests sent
 * together are both under way at once, as they would be in the runtime.
 */
let lag = false;
const answered = () => (lag ? new Promise<void>((done) => setImmediate(done)) : Promise.resolve());
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
    await answered();
    return this.exec();
  }
  async all() {
    await answered();
    return this.exec();
  }
  async first() {
    await answered();
    return this.exec().results[0] ?? null;
  }
}

class FakeSocket {
  sent: HarborServerMessage[] = [];
  closed: number | null = null;
  tags: string[] = [];
  constructor(private attachment: HarborPlayer | null = null) {}
  deserializeAttachment() {
    return this.attachment;
  }
  serializeAttachment(next: HarborPlayer | null) {
    this.attachment = next;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
  }
  /** Every telling of the muster this socket has had, in order (null: "there is none any more"). */
  get musters(): (Muster | null)[] {
    return this.sent.flatMap((m) => (m.type === "muster" ? [m.muster] : []));
  }
  /** What kinds of message it has had, in order. */
  get kinds(): string[] {
    return this.sent.map((m) => m.type);
  }
}

/** What the room keeps in its storage under "muster". */
interface Kept {
  crewId: string;
  stone?: unknown;
  muster: Muster;
}

const CREW = "CREWAA";
const OTHER = "CREWBB";
/** A moment for the clock to start at: the first of November 2026, noon. */
const T0 = Date.UTC(2026, 10, 1, 12);

const ann: MusterMember = { id: "ann", name: "Ann" };
const bo: MusterMember = { id: "bo", name: "Bo" };
const cy: MusterMember = { id: "cy", name: "Cy" };
const dee: MusterMember = { id: "dee", name: "Dee" };
const eve: MusterMember = { id: "eve", name: "Eve" };
const fay: MusterMember = { id: "fay", name: "Fay" };

let sql: DatabaseSync;
let db: D1Database;
let sockets: FakeSocket[];
let storage: Map<string, unknown>;
let alarm: number | null;

/** A room as the runtime would hand it over: fresh in memory, with whatever sockets, storage and alarm outlived the last one. */
function room() {
  const ctx = {
    setWebSocketAutoResponse() {},
    getWebSockets: (tag?: string) => sockets.filter((s) => s.closed === null && (!tag || s.tags.includes(tag))),
    acceptWebSocket(ws: FakeSocket, tags: string[] = []) {
      ws.tags = tags;
      sockets.push(ws);
    },
    // Copied in and out, as the runtime does: nothing kept is the object the room still holds.
    storage: {
      get: async (key: string) => (storage.has(key) ? structuredClone(storage.get(key)) : undefined),
      put: async (key: string, value: unknown) => void storage.set(key, structuredClone(value)),
      delete: async (key: string) => storage.delete(key),
      setAlarm: async (at: number) => void (alarm = at),
      getAlarm: async () => alarm,
      deleteAlarm: async () => void (alarm = null),
    },
  };
  return new HarborRoom(ctx as never, { DB: db } as never);
}

/** Someone already walking the Harbor: a socket the room finds when it wakes. */
function inTown(who: MusterMember): FakeSocket {
  const ws = new FakeSocket({ id: who.id, name: who.name, classId: "qa_paladin", level: 1, pos: HARBOR_SPAWN });
  ws.tags = [who.id];
  sockets.push(ws);
  return ws;
}

/** Someone walks into the Harbor: the upgrade request the worker passes on. */
async function connect(who: MusterMember, to = room()): Promise<FakeSocket> {
  const ws = new FakeSocket();
  nextServerSocket = ws;
  const res = await to.fetch({ url: "https://harbor/ws", headers: new Headers({ Upgrade: "websocket", "x-crew-id": CREW, "x-player-id": who.id, "x-player-name": encodeURIComponent(who.name) }) } as never);
  if (res.status !== 101) throw new Error(`refused: ${await res.text()}`);
  return ws;
}

/** Ask the room as the worker's `musterRoom` does. */
async function ask(path: "" | "/call" | "/answer", body?: unknown, to = room()): Promise<{ status: number; json: { muster?: Muster | null; alone?: true; error?: string } }> {
  const res = await to.fetch(
    new Request(`https://harbor/muster${path}`, {
      method: body === undefined ? "GET" : "POST",
      headers: { "x-crew-id": CREW, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
  );
  return { status: res.status, json: (await res.json()) as { muster?: Muster | null; alone?: true; error?: string } };
}

/** Call a muster the way the worker does: the place is scouted first, and what was seen of it is what the room is told. */
async function call(by: MusterMember, node: string, stone?: string) {
  const seen = await scoutNode(db, CREW, node, stone);
  if ("error" in seen) throw new Error(seen.error);
  if ("live" in seen) throw new Error(`a map is being fought through there already: ${seen.live}`);
  return ask("/call", { by, to: seen, stone });
}
const answer = (who: MusterMember, said: MusterAnswer | string) => ask("/answer", { who, answer: said });
/** Call one and expect it to be taken. */
async function called(by: MusterMember, node: string, stone?: string): Promise<Muster> {
  const res = await call(by, node, stone);
  if (res.status !== 200 || !res.json.muster) throw new Error(`not called: ${JSON.stringify(res.json)}`);
  return res.json.muster;
}

const kept = () => storage.get("muster") as Kept | undefined;
const seed = atlasSeed(CREW);
const nodeOf = (id: string) => atlasNodeById(seed, id)!;
/** A landfall beside the Harbor: it needs no lodestone. */
const first = () => nodeOf(ATLAS_HOME).links[0];
/** A place a ring out from `from`, which a route runs to once `from` is cleared: it needs a lodestone. */
const beyond = (from: string) => nodeOf(from).links.find((id) => nodeOf(id).ring === 2)!;
/** Clear the landfall beside the Harbor and give the place beyond it. */
async function farPlace(): Promise<string> {
  const near = first();
  await clearNode(db, CREW, near);
  const far = beyond(near);
  expect(needsStone(nodeOf(far))).toBe(true);
  return far;
}
const give = (who: string, stone: ZoneMod[] = []) =>
  sql.prepare("INSERT INTO consumables (player_id, kind, qty) VALUES (?, ?, 1) ON CONFLICT(player_id, kind) DO UPDATE SET qty = qty + 1").run(who, stoneItem(stone));
const zones = () => sql.prepare("SELECT code, options_json, kind, crew_id, node, status, created_by FROM zones ORDER BY created_at, code").all() as { code: string; options_json: string; kind: string; crew_id: string; node: string; status: string; created_by: string }[];
const nodeRow = (node: string) => sql.prepare("SELECT status, zone_code, attempts, opened_by, stone FROM atlas_nodes WHERE crew_id = ? AND node = ?").get(CREW, node) as { status: string; zone_code: string | null; attempts: number; opened_by: string | null; stone: string | null } | undefined;
const optionsOf = (code: string) => JSON.parse(zones().find((z) => z.code === code)!.options_json) as ZoneOptions;

beforeEach(() => {
  // Only the clock is faked: nothing here waits on a timer.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  sql = new DatabaseSync(":memory:");
  const dir = new URL("../migrations/", import.meta.url);
  for (const file of readdirSync(dir).sort()) sql.exec(readFileSync(new URL(file, dir), "utf8"));
  db = { prepare: (text: string) => new Stmt(sql, text), batch: async (stmts: Stmt[]) => (await answered(), stmts.map((s) => s.exec())) } as unknown as D1Database;
  for (const [who, crew] of [[ann, CREW], [bo, CREW], [cy, CREW], [dee, CREW], [eve, CREW], [fay, CREW], [{ id: "zed", name: "Zed" }, OTHER]] as const) {
    sql.prepare("INSERT INTO players (id, name, created_at) VALUES (?, ?, ?)").run(who.id, who.name, T0);
    sql.prepare("INSERT INTO characters (player_id, name, class_id, status, str, int_stat, vit, agi, dex, gold, created_at) VALUES (?, ?, 'qa_paladin', 'active', 5, 5, 5, 5, 5, 100, ?)").run(who.id, who.name, T0);
    sql.prepare("INSERT OR IGNORE INTO crews (id, name, created_by, created_at) VALUES (?, 'Crew', ?, ?)").run(crew, who.id, T0);
    sql.prepare("INSERT INTO crew_members (crew_id, player_id, joined_at) VALUES (?, ?, ?)").run(crew, who.id, T0);
  }
  sockets = [];
  storage = new Map();
  alarm = null;
  lag = false;
});

afterEach(() => {
  vi.useRealTimers();
});

describe("calling a muster", () => {
  it("is not called with nobody else in town: there is nobody to ask, and nothing is kept or told", async () => {
    const mine = inTown(ann);
    expect(await call(ann, first())).toEqual({ status: 200, json: { alone: true } });
    expect(kept()).toBeUndefined();
    expect(alarm).toBeNull();
    expect(mine.sent).toEqual([]);
    // Nor with nobody in town at all: whoever looks at the atlas has no socket of their own here.
    sockets = [];
    expect((await call(ann, first())).json).toEqual({ alone: true });
    // The room made nothing: the worker makes the map for the one who is alone.
    expect(zones()).toEqual([]);
    expect((await ask("")).json).toEqual({ muster: null });
  });

  it("with others in town it is kept, its alarm is set for its deadline, and every socket hears of it", async () => {
    const [a, b, c] = [inTown(ann), inTown(bo), inTown(cy)];
    const node = first();
    const res = await call(ann, node);
    expect(res.status).toBe(200);
    const muster = res.json.muster!;
    const place = nodeOf(node);
    expect(muster).toMatchObject({ by: ann, node, place: place.name, level: place.level, deadline: T0 + MUSTER_MS, asked: [bo, cy], ready: [ann], declined: [] });
    expect(muster.site).toEqual(expect.any(String));
    expect(muster.id).toMatch(/^[0-9a-f]{8}$/);
    expect(muster).not.toHaveProperty("code");
    expect(muster).not.toHaveProperty("failed");
    expect(kept()).toEqual({ crewId: CREW, stone: undefined, muster });
    expect(alarm).toBe(muster.deadline);
    for (const ws of [a, b, c]) expect(ws.sent).toEqual([{ type: "muster", muster }]);
    // Whoever asks after it (the atlas does, having no socket) is told the same.
    expect((await ask("")).json).toEqual({ muster });
    // Nothing is made yet.
    expect(zones()).toEqual([]);
    expect(nodeRow(node)).toBeUndefined();
  });

  it("asks whoever is in town even when the caller is not (they are looking at the atlas)", async () => {
    const b = inTown(bo);
    const muster = await called(ann, first());
    expect(muster.asked).toEqual([bo]);
    expect(muster.ready).toEqual([ann]);
    expect(b.musters).toEqual([muster]);
  });

  it("asks each player once, however many sockets they have, and nobody whose socket has been replaced", async () => {
    inTown(ann);
    inTown(bo);
    inTown(bo);
    // A socket a newer tab took over has its attachment cleared: there is nobody behind it.
    const old = inTown(cy);
    old.serializeAttachment(null);
    expect((await called(ann, first())).asked).toEqual([bo]);
  });

  it("a second one is refused while the first is open, naming whoever called it", async () => {
    const [a, b] = [inTown(ann), inTown(bo)];
    const muster = await called(ann, first());
    const others = nodeOf(ATLAS_HOME).links[1];
    expect(await call(bo, others)).toEqual({ status: 409, json: { error: `Ann is mustering for ${muster.place}: answer that first.` } });
    expect(await call(ann, others)).toEqual({ status: 409, json: { error: "You are mustering already." } });
    // The first stands as it was, and nobody was told anything new.
    expect(kept()!.muster).toEqual(muster);
    expect(alarm).toBe(muster.deadline);
    expect(a.sent).toHaveLength(1);
    expect(b.sent).toHaveLength(1);
  });

  it("takes nothing that names no caller or no place", async () => {
    inTown(ann);
    inTown(bo);
    const to = { node: first(), place: "Somewhere" };
    expect(await ask("/call", { to })).toMatchObject({ status: 400, json: { error: expect.any(String) } });
    expect(await ask("/call", { by: ann })).toMatchObject({ status: 400 });
    expect(await ask("/call", { by: { name: "Ann" }, to })).toMatchObject({ status: 400 });
    expect(await ask("/call", "nonsense")).toMatchObject({ status: 400 });
    expect(kept()).toBeUndefined();
    expect(alarm).toBeNull();
  });

  it("needs to be told which crew it is for", async () => {
    const res = await room().fetch(new Request("https://harbor/muster"));
    expect(res.status).toBe(400);
  });
});

describe("answering a muster", () => {
  it("keeps who is ready and who is not, and tells every socket each time", async () => {
    const [a, b, c, d] = [inTown(ann), inTown(bo), inTown(cy), inTown(dee)];
    const muster = await called(ann, first());
    const one = await answer(bo, "ready");
    expect(one.status).toBe(200);
    expect(one.json.muster).toEqual({ ...muster, ready: [ann, bo] });
    expect(kept()!.muster).toEqual(one.json.muster);
    const two = await answer(cy, "no");
    expect(two.json.muster).toEqual({ ...muster, ready: [ann, bo], declined: ["cy"] });
    expect(kept()!.muster).toEqual(two.json.muster);
    // Bo thinks better of it.
    const three = await answer(bo, "no");
    expect(three.json.muster).toEqual({ ...muster, ready: [ann], declined: ["cy", "bo"] });
    for (const ws of [a, b, c, d]) expect(ws.musters).toEqual([muster, one.json.muster, two.json.muster, three.json.muster]);
    // Dee has said nothing: it is still waiting, with its alarm where it was, and no map made.
    expect(kept()!.muster).not.toHaveProperty("endedAt");
    expect(alarm).toBe(muster.deadline);
    expect(zones()).toEqual([]);
    expect((await ask("")).json.muster).toEqual(three.json.muster);
  });

  it("keeps the crew and the lodestone with it through the answers, and sends neither to anyone", async () => {
    const b = inTown(bo);
    inTown(cy);
    give("ann", ["hardy"]);
    const muster = await called(ann, first(), "hardy");
    expect(kept()).toMatchObject({ crewId: CREW, stone: "hardy" });
    await answer(bo, "ready");
    expect(kept()).toMatchObject({ crewId: CREW, stone: "hardy", muster: { ready: [ann, bo] } });
    for (const told of b.musters) {
      expect(told).not.toHaveProperty("stone");
      expect(told).not.toHaveProperty("crewId");
    }
    expect(muster).not.toHaveProperty("stone");
  });

  it("makes the map for as many as are ready once the last one asked has answered", async () => {
    const [a, b, c] = [inTown(ann), inTown(bo), inTown(cy)];
    const node = first();
    const muster = await called(ann, node);
    await answer(bo, "ready");
    vi.setSystemTime(T0 + 7000);
    const last = await answer(cy, "no");
    expect(last.status).toBe(200);
    const ended = last.json.muster!;
    expect(ended).toEqual({ ...muster, ready: [ann, bo], declined: ["cy"], code: expect.stringMatching(/^[A-Z]{4}$/), endedAt: T0 + 7000 });
    expect(ended).not.toHaveProperty("failed");
    // The map: one, for the two who are going, on the crew's chart at that place, opened by whoever called.
    const made = zones();
    expect(made).toHaveLength(1);
    expect(made[0]).toMatchObject({ code: ended.code, kind: "atlas", crew_id: CREW, node, status: "open", created_by: "ann" });
    expect(optionsOf(ended.code!)).toMatchObject({ party: 2, name: nodeOf(node).name });
    expect(nodeRow(node)).toEqual({ status: "open", zone_code: ended.code, attempts: 1, opened_by: "ann", stone: null });
    expect((await chartFor(db, CREW)).nodes.find((n) => n.id === node)).toMatchObject({ state: "open", zone: ended.code });
    // Everyone hears how it ended, and then that the board has changed.
    for (const ws of [a, b, c]) {
      expect(ws.musters.at(-1)).toEqual(ended);
      expect(ws.kinds.slice(-2)).toEqual(["muster", "board"]);
    }
    // It is kept a little while (without the stone, which is spent or was never there), and its alarm is for when it is dropped.
    expect(kept()).toEqual({ crewId: CREW, muster: ended });
    expect(alarm).toBe(T0 + 7000 + MUSTER_LINGER_MS);
    expect((await ask("")).json).toEqual({ muster: ended });
  });

  it("starts with the caller alone when everyone asked says no", async () => {
    inTown(ann);
    inTown(bo);
    inTown(cy);
    await called(ann, first());
    await answer(bo, "no");
    const ended = (await answer(cy, "no")).json.muster!;
    expect(ended.ready).toEqual([ann]);
    expect(optionsOf(ended.code!).party).toBe(1);
  });

  it("starts as soon as the party is full, whoever has yet to answer", async () => {
    for (const who of [ann, bo, cy, dee, eve, fay]) inTown(who);
    const muster = await called(ann, first());
    expect(muster.asked).toEqual([bo, cy, dee, eve, fay]);
    expect((await answer(bo, "ready")).json.muster).not.toHaveProperty("code");
    expect((await answer(cy, "ready")).json.muster).not.toHaveProperty("code");
    const full = (await answer(dee, "ready")).json.muster!;
    expect(full.ready).toEqual([ann, bo, cy, dee]);
    expect(full.ready).toHaveLength(MUSTER_PARTY);
    expect(optionsOf(full.code!).party).toBe(MUSTER_PARTY);
    // It has gone: the fifth is too late.
    expect(await answer(eve, "ready")).toEqual({ status: 409, json: { error: "There is no muster to answer." } });
  });

  it("the caller's start sets out with whoever is ready, and nobody else can say it", async () => {
    const [a, b, c, d] = [inTown(ann), inTown(bo), inTown(cy), inTown(dee)];
    const node = first();
    const muster = await called(ann, node);
    await answer(bo, "ready");
    expect(await answer(bo, "start")).toEqual({ status: 409, json: { error: "Only Ann can do that: it is their muster." } });
    expect(zones()).toEqual([]);
    expect(kept()!.muster).toEqual({ ...muster, ready: [ann, bo] });
    vi.setSystemTime(T0 + 3000);
    const ended = (await answer(ann, "start")).json.muster!;
    // Cy and Dee never answered: they are neither ready nor declined, and the map is for two.
    expect(ended).toEqual({ ...muster, ready: [ann, bo], declined: [], code: expect.any(String), endedAt: T0 + 3000 });
    expect(optionsOf(ended.code!).party).toBe(2);
    expect(nodeRow(node)).toMatchObject({ zone_code: ended.code, opened_by: "ann" });
    for (const ws of [a, b, c, d]) expect(ws.musters.at(-1)).toEqual(ended);
  });

  it("the caller's cancel ends it as fallen through: no map, and the lodestone still in the pack", async () => {
    const [a, b] = [inTown(ann), inTown(bo)];
    const far = await farPlace();
    give("ann");
    const muster = await called(ann, far, "");
    expect(await answer(bo, "cancel")).toMatchObject({ status: 409, json: { error: expect.stringMatching(/Only Ann/) } });
    vi.setSystemTime(T0 + 2000);
    const off = await answer(ann, "cancel");
    expect(off).toEqual({ status: 200, json: { muster: { ...muster, failed: "Ann called it off.", endedAt: T0 + 2000 } } });
    expect(off.json.muster).not.toHaveProperty("code");
    expect(zones()).toEqual([]);
    expect(nodeRow(far)).toBeUndefined();
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: [], qty: 1 }]);
    for (const ws of [a, b]) {
      expect(ws.musters.at(-1)).toEqual(off.json.muster);
      // The chart has not changed, so the board is not told again.
      expect(ws.kinds).not.toContain("board");
    }
    expect(kept()).toEqual({ crewId: CREW, muster: off.json.muster });
    expect(alarm).toBe(T0 + 2000 + MUSTER_LINGER_MS);
    // It takes no more answers, and its alarm coming round later makes nothing of it.
    expect(await answer(bo, "ready")).toEqual({ status: 409, json: { error: "There is no muster to answer." } });
    vi.setSystemTime(T0 + MUSTER_MS);
    await room().alarm();
    expect(zones()).toEqual([]);
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: [], qty: 1 }]);
  });

  it("another can be called straight after one has ended, while that one is still being told", async () => {
    inTown(ann);
    const b = inTown(bo);
    await called(ann, first());
    await answer(ann, "cancel");
    vi.setSystemTime(T0 + 1000);
    const next = await called(bo, first());
    expect(next).toMatchObject({ by: bo, asked: [ann], ready: [bo], deadline: T0 + 1000 + MUSTER_MS });
    expect(kept()!.muster).toEqual(next);
    expect(alarm).toBe(next.deadline);
    expect(b.musters.at(-1)).toEqual(next);
    // The alarm the ended one would have had (to drop it) comes to nothing now: the new one is still waiting.
    vi.setSystemTime(T0 + MUSTER_LINGER_MS);
    await room().alarm();
    expect(kept()!.muster).toEqual(next);
    expect(alarm).toBe(next.deadline);
    expect(b.musters.at(-1)).toEqual(next);
  });

  it("takes only the four answers, from someone, and only while one is open", async () => {
    inTown(ann);
    inTown(bo);
    expect(await answer(bo, "ready")).toEqual({ status: 409, json: { error: "There is no muster to answer." } });
    const muster = await called(ann, first());
    expect(await answer(bo, "maybe")).toEqual({ status: 400, json: { error: "That is no answer." } });
    expect(await ask("/answer", { who: bo })).toMatchObject({ status: 400 });
    expect(await ask("/answer", { answer: "ready" })).toMatchObject({ status: 400 });
    expect(await ask("/answer", "ready")).toMatchObject({ status: 400 });
    // The caller is going already, and cannot say no to their own.
    expect(await answer(ann, "ready")).toMatchObject({ status: 409, json: { error: expect.stringMatching(/You called it/) } });
    expect(await answer(ann, "no")).toMatchObject({ status: 409 });
    expect(kept()!.muster).toEqual(muster);
    expect(zones()).toEqual([]);
  });

  it("someone who walked in after it was called can come too, and is counted", async () => {
    inTown(ann);
    inTown(bo);
    const node = first();
    await called(ann, node);
    inTown(cy);
    expect((await answer(cy, "ready")).json.muster).toMatchObject({ asked: [bo], ready: [ann, cy] });
    const ended = (await answer(bo, "ready")).json.muster!;
    expect(ended.ready).toEqual([ann, cy, bo]);
    expect(optionsOf(ended.code!).party).toBe(3);
  });

  it("joins the map somebody made there meanwhile, and spends nothing", async () => {
    inTown(ann);
    const b = inTown(bo);
    const far = await farPlace();
    give("ann");
    give("cy");
    await called(ann, far, "");
    // Cy, out on the atlas, sets out for the same place on their own before the muster starts.
    const theirs = await openNode(db, CREW, "cy", far, 1, "");
    if ("error" in theirs) throw new Error(theirs.error);
    const ended = (await answer(bo, "ready")).json.muster!;
    expect(ended.code).toBe(theirs.code);
    expect(zones()).toHaveLength(1);
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: [], qty: 1 }]);
    expect(b.musters.at(-1)).toEqual(ended);
  });
});

describe("a muster and the lodestone", () => {
  it("spends the caller's stone when it starts, not when it is called", async () => {
    inTown(ann);
    inTown(bo);
    inTown(cy);
    const far = await farPlace();
    give("ann");
    give("bo");
    await called(ann, far, "");
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: [], qty: 1 }]);
    await answer(bo, "ready");
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: [], qty: 1 }]);
    expect(zones()).toEqual([]);
    const ended = (await answer(cy, "ready")).json.muster!;
    expect(ended.code).toEqual(expect.any(String));
    // Ann's is gone; Bo, who only came along, still has theirs.
    expect(await lodestonesOf(db, "ann")).toEqual([]);
    expect(await lodestonesOf(db, "bo")).toEqual([{ stone: [], qty: 1 }]);
    expect(optionsOf(ended.code!).party).toBe(3);
    expect(nodeRow(far)).toEqual({ status: "open", zone_code: ended.code, attempts: 1, opened_by: "ann", stone: "" });
    expect((await chartFor(db, CREW)).nodes.find((n) => n.id === far)).toMatchObject({ zone: ended.code, stone: [] });
  });

  it("a stone that carries something makes the map carry it", async () => {
    inTown(ann);
    inTown(bo);
    const node = first();
    give("ann", ["hardy", "numerous"]);
    await called(ann, node, "numerous+hardy");
    const ended = (await answer(bo, "no")).json.muster!;
    expect(optionsOf(ended.code!).mods).toEqual(["hardy", "numerous"]);
    expect(optionsOf(ended.code!).party).toBe(1);
    expect(await lodestonesOf(db, "ann")).toEqual([]);
    expect(nodeRow(node)).toMatchObject({ zone_code: ended.code, stone: "hardy+numerous" });
  });

  it("falls through when the place needs a stone the caller turns out not to have: nothing is made", async () => {
    const [a, b] = [inTown(ann), inTown(bo)];
    const far = await farPlace();
    // Bo has one. It is not Ann's to set out with.
    give("bo");
    const muster = await called(ann, far, "");
    vi.setSystemTime(T0 + 4000);
    const ended = (await answer(bo, "ready")).json.muster!;
    expect(ended).toEqual({ ...muster, ready: [ann, bo], failed: expect.stringMatching(/You have no plain lodestone/), endedAt: T0 + 4000 });
    expect(ended).not.toHaveProperty("code");
    expect(zones()).toEqual([]);
    expect(nodeRow(far)).toBeUndefined();
    expect(await lodestonesOf(db, "bo")).toEqual([{ stone: [], qty: 1 }]);
    for (const ws of [a, b]) {
      expect(ws.musters.at(-1)).toEqual(ended);
      expect(ws.kinds).not.toContain("board");
    }
    expect(alarm).toBe(T0 + 4000 + MUSTER_LINGER_MS);
    // It is over: the place can be mustered for again once the stone is found.
    give("ann");
    const again = await called(ann, far, "");
    expect(again.id).not.toBe(muster.id);
  });

  it("falls through the same way when the stone was given away while the crew made up its mind", async () => {
    inTown(ann);
    inTown(bo);
    const far = await farPlace();
    give("ann");
    await called(ann, far, "");
    sql.prepare("DELETE FROM consumables WHERE player_id = 'ann'").run();
    const ended = (await answer(bo, "ready")).json.muster!;
    expect(ended.failed).toMatch(/You have no plain lodestone/);
    expect(zones()).toEqual([]);
  });

  it("falls through when it is told of no stone at all for a place that needs one", async () => {
    inTown(ann);
    inTown(bo);
    const far = await farPlace();
    // The worker's scouting refuses this before a muster is called; the room, asked all the same, makes nothing.
    expect(await scoutNode(db, CREW, far)).toMatchObject({ status: 409, error: expect.stringMatching(/needs a lodestone/) });
    const res = await ask("/call", { by: ann, to: { node: far, place: nodeOf(far).name } });
    expect(res.status).toBe(200);
    const ended = (await answer(bo, "ready")).json.muster!;
    expect(ended.failed).toMatch(/needs a lodestone/);
    expect(zones()).toEqual([]);
    expect(nodeRow(far)).toBeUndefined();
  });

  it("falls through when the place was cleared while the crew made up its mind", async () => {
    inTown(ann);
    inTown(bo);
    const node = first();
    await called(ann, node);
    await clearNode(db, CREW, node);
    const ended = (await answer(bo, "ready")).json.muster!;
    expect(ended.failed).toMatch(/cleared already/);
    expect(zones()).toEqual([]);
  });
});

describe("a muster's alarm", () => {
  it("starts it at the deadline with whoever is ready, in a room that has slept since", async () => {
    const [a, b, c] = [inTown(ann), inTown(bo), inTown(cy)];
    const node = first();
    const muster = await called(ann, node);
    await answer(bo, "ready");
    expect(alarm).toBe(T0 + MUSTER_MS);
    vi.setSystemTime(T0 + MUSTER_MS);
    // A fresh room over the same storage and sockets: what a hibernated object is when its alarm wakes it.
    await room().alarm();
    const ended = kept()!.muster;
    expect(ended).toEqual({ ...muster, ready: [ann, bo], code: expect.any(String), endedAt: T0 + MUSTER_MS });
    expect(optionsOf(ended.code!).party).toBe(2);
    expect(nodeRow(node)).toMatchObject({ zone_code: ended.code, attempts: 1, opened_by: "ann" });
    for (const ws of [a, b, c]) {
      expect(ws.musters.at(-1)).toEqual(ended);
      expect(ws.kinds.at(-1)).toBe("board");
    }
    expect(alarm).toBe(T0 + MUSTER_MS + MUSTER_LINGER_MS);
  });

  it("starts it for the caller alone when nobody answered in time, and spends their stone then", async () => {
    inTown(ann);
    inTown(bo);
    const far = await farPlace();
    give("ann");
    await called(ann, far, "");
    vi.setSystemTime(T0 + MUSTER_MS + 250);
    await room().alarm();
    const ended = kept()!.muster;
    expect(ended).toMatchObject({ ready: [ann], declined: [], endedAt: T0 + MUSTER_MS + 250 });
    expect(optionsOf(ended.code!).party).toBe(1);
    expect(await lodestonesOf(db, "ann")).toEqual([]);
  });

  it("coming early starts nothing, and is set again for the deadline", async () => {
    inTown(ann);
    const b = inTown(bo);
    const muster = await called(ann, first());
    alarm = null;
    vi.setSystemTime(T0 + MUSTER_MS - 1);
    await room().alarm();
    expect(kept()!.muster).toEqual(muster);
    expect(alarm).toBe(muster.deadline);
    expect(zones()).toEqual([]);
    expect(b.musters).toEqual([muster]);
  });

  it("with no muster kept does nothing", async () => {
    const b = inTown(bo);
    await room().alarm();
    expect(b.sent).toEqual([]);
    expect(alarm).toBeNull();
    expect(zones()).toEqual([]);
  });

  it("ends it as fallen through at the deadline when the map cannot be made", async () => {
    inTown(ann);
    const b = inTown(bo);
    const far = await farPlace();
    await called(ann, far, "");
    vi.setSystemTime(T0 + MUSTER_MS);
    await room().alarm();
    expect(kept()!.muster).toMatchObject({ failed: expect.stringMatching(/You have no plain lodestone/), endedAt: T0 + MUSTER_MS });
    expect(b.musters.at(-1)).toEqual(kept()!.muster);
    expect(zones()).toEqual([]);
    expect(alarm).toBe(T0 + MUSTER_MS + MUSTER_LINGER_MS);
  });
});

describe("a muster that has ended", () => {
  /** Ann and Bo set out at T0 + 5s. */
  async function setOut() {
    const [a, b, c] = [inTown(ann), inTown(bo), inTown(cy)];
    await called(ann, first());
    await answer(bo, "ready");
    vi.setSystemTime(T0 + 5000);
    const ended = (await answer(cy, "no")).json.muster!;
    return { a, b, c, ended, endedAt: T0 + 5000 };
  }

  it("is still told for MUSTER_LINGER_MS, and then it is gone and every socket is told there is none", async () => {
    const { a, b, c, ended, endedAt } = await setOut();
    vi.setSystemTime(endedAt + MUSTER_LINGER_MS - 1);
    expect((await ask("")).json).toEqual({ muster: ended });
    // The alarm coming a moment early drops nothing, and is set again for the moment it should.
    alarm = null;
    await room().alarm();
    expect(kept()).toEqual({ crewId: CREW, muster: ended });
    expect(alarm).toBe(endedAt + MUSTER_LINGER_MS);
    expect(a.musters.at(-1)).toEqual(ended);

    vi.setSystemTime(endedAt + MUSTER_LINGER_MS);
    const before = b.sent.length;
    await room().alarm();
    expect(kept()).toBeUndefined();
    for (const ws of [a, b, c]) expect(ws.sent.at(-1)).toEqual({ type: "muster", muster: null });
    expect(b.sent).toHaveLength(before + 1);
    expect((await ask("")).json).toEqual({ muster: null });
    // The map it made is none the worse for that.
    expect(zones()).toHaveLength(1);
    expect(await getZoneRow(db, ended.code!)).toMatchObject({ status: "open" });
  });

  it("is gone for whoever asks after it once that long has passed, alarm or no alarm", async () => {
    const { ended, endedAt } = await setOut();
    expect((await ask("")).json).toEqual({ muster: ended });
    vi.setSystemTime(endedAt + MUSTER_LINGER_MS);
    expect((await ask("")).json).toEqual({ muster: null });
    expect(kept()).toBeUndefined();
  });

  // KNOWN BUG (reported, not fixed here): `musterNow` drops a muster that has been told long enough without telling
  // the sockets, and `alarm()` then finds nothing kept and says nothing either. So when anything asks after the
  // muster (the atlas polls GET /muster every 1.5s; a socket connecting asks too) between the moment it lapses and
  // the alarm running, nobody in town is ever sent `muster: null`, and their panel stays up. Written as the
  // behaviour wanted: turn `it.fails` into `it` once the room tells the sockets whichever way the muster is dropped.
  it("tells the sockets it is gone even when someone asking after it was the one to drop it", async () => {
    const { b, endedAt } = await setOut();
    vi.setSystemTime(endedAt + MUSTER_LINGER_MS);
    expect((await ask("")).json).toEqual({ muster: null });
    await room().alarm();
    expect(b.musters.at(-1)).toBeNull();
  });

  it("takes no answers, and lets the place be joined rather than mustered for", async () => {
    const { ended } = await setOut();
    expect(await answer(cy, "ready")).toEqual({ status: 409, json: { error: "There is no muster to answer." } });
    expect(await answer(ann, "cancel")).toMatchObject({ status: 409 });
    expect(await scoutNode(db, CREW, first())).toEqual({ live: ended.code });
    expect(zones()).toHaveLength(1);
  });
});

describe("walking into town during a muster", () => {
  it("a socket that connects while one is open is sent it straight after its snapshot", async () => {
    const [a, b] = [inTown(ann), inTown(bo)];
    inTown(cy);
    const muster = await called(ann, first());
    // Bo is ready and Cy has yet to say: it is still open when Dee walks in.
    const now = (await answer(bo, "ready")).json.muster!;
    expect(now).toEqual({ ...muster, ready: [ann, bo] });
    const d = await connect(dee);
    expect(d.kinds).toEqual(["snapshot", "muster"]);
    expect(d.sent[0]).toMatchObject({ type: "snapshot", you: "dee", crew: { id: CREW } });
    expect(d.sent[1]).toEqual({ type: "muster", muster: now });
    // The others hear that Dee is here, and are not told the muster over again for it.
    expect(a.kinds.slice(-2)).toEqual(["joined", "board"]);
    expect(b.musters).toEqual([muster, now]);
    // Dee was not asked, so nobody waits for them; but they can say they are coming, and are counted.
    const more = (await answer(dee, "ready")).json.muster!;
    expect(more).toEqual({ ...muster, ready: [ann, bo, dee] });
    expect(d.musters.at(-1)).toEqual(more);
    const ended = (await answer(cy, "no")).json.muster!;
    expect(optionsOf(ended.code!).party).toBe(3);
    expect(d.musters.at(-1)).toEqual(ended);
  });

  it("one that connects just after it ended is told how it ended; one that connects later, or with none on, is told there is none", async () => {
    // Nobody is mustering.
    inTown(ann);
    inTown(bo);
    expect((await connect(cy)).kinds).toEqual(["snapshot", "muster"]);
    await called(ann, first());
    vi.setSystemTime(T0 + 1000);
    const ended = (await answer(ann, "start")).json.muster!;
    expect(ended.code).toEqual(expect.any(String));
    vi.setSystemTime(T0 + 1000 + MUSTER_LINGER_MS - 1);
    const d = await connect(dee);
    expect(d.kinds).toEqual(["snapshot", "muster"]);
    expect(d.sent[1]).toEqual({ type: "muster", muster: ended });
    vi.setSystemTime(T0 + 1000 + MUSTER_LINGER_MS);
    expect((await connect(eve)).kinds).toEqual(["snapshot", "muster"]);
  });

  it("the caller's own new tab is told of their muster too, and they are still the one going", async () => {
    inTown(ann);
    inTown(bo);
    const muster = await called(ann, first());
    const tab = await connect(ann);
    expect(tab.sent[1]).toEqual({ type: "muster", muster });
    expect(kept()!.muster.ready).toEqual([ann]);
  });
});

describe("two things starting a muster at once", () => {
  // `startMuster` waits on D1 (`openNode`) between reading the muster and keeping it as ended, and a Durable Object
  // takes other requests and alarms while it waits on anything but its own storage. A second starter in that gap
  // (the caller's "start anyway" as the last answer lands, or the alarm at the deadline as someone answers) must
  // not make a second map: the room marks the muster as starting before it waits on anything.
  it("makes one map, and tells one code", async () => {
    const [a, b] = [inTown(ann), inTown(bo)];
    inTown(cy);
    const node = first();
    await called(ann, node);
    await answer(bo, "ready");
    lag = true;
    // Cy's is the last answer asked for, and Ann presses "start anyway" as it lands.
    // (Both reach the one room that is awake, as they would: a crew's Harbor is a single object.)
    const one = room();
    await Promise.all([ask("/answer", { who: cy, answer: "no" }, one), ask("/answer", { who: ann, answer: "start" }, one)]);
    lag = false;
    expect(zones()).toHaveLength(1);
    for (const ws of [a, b]) expect(new Set(ws.musters.flatMap((m) => (m?.code ? [m.code] : []))).size).toBe(1);
    expect(nodeRow(node)).toMatchObject({ attempts: 1, zone_code: zones()[0].code });
  });

  it("makes one map and spends one lodestone when the last answer comes as the alarm goes", async () => {
    inTown(ann);
    const b = inTown(bo);
    const far = await farPlace();
    give("ann");
    give("ann");
    await called(ann, far, "");
    vi.setSystemTime(T0 + MUSTER_MS);
    lag = true;
    // Bo answers on the stroke of the deadline, as the alarm goes.
    const one = room();
    await Promise.all([ask("/answer", { who: bo, answer: "ready" }, one), one.alarm()]);
    lag = false;
    expect(zones()).toHaveLength(1);
    expect(await lodestonesOf(db, "ann")).toEqual([{ stone: [], qty: 1 }]);
    expect(b.musters.at(-1)).toMatchObject({ code: zones()[0].code });
    expect(kept()!.muster).not.toHaveProperty("failed");
  });
});

describe("a muster's map once it is left alone", () => {
  it("a place whose map has gone stale is mustered for afresh", async () => {
    inTown(ann);
    inTown(bo);
    const node = first();
    await called(ann, node);
    const one = (await answer(bo, "ready")).json.muster!;
    vi.setSystemTime(T0 + CAVE_IDLE_MS + 1000);
    const two = await called(bo, node);
    expect(two.id).not.toBe(one.id);
    const ended = (await answer(ann, "ready")).json.muster!;
    expect(ended.code).not.toBe(one.code);
    expect(nodeRow(node)).toMatchObject({ attempts: 2, zone_code: ended.code, opened_by: "bo" });
  });
});
