// Walking into a crew's Harbor and out of it again, as HarborRoom keeps it: what the newcomer and everyone else
// are told and in what order, where the newcomer stands (the spawn, a door they stepped out of, where they stood
// before, or where an older tab of theirs stands), and what else the room answers about who is here. The room is
// driven the way the worker drives it, with fake hibernatable sockets and the runtime's side of a room
// (rooms.ts), against a real SQLite database with the game's migrations applied (d1.ts). Walking, looking,
// getting unstuck and the muster have tests of their own (harborWalk, harborLook, harborUnstick, harborMuster).

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARBOR_MAX_SAY, HARBOR_PLOTS, HARBOR_PUB, HARBOR_SPAWN, generateHarbor, harborPath, type HarborPlayer, type HarborServerMessage } from "@gantt-quest/world";
import { addHero, openDb } from "./d1";
import { HarborSocket, fakeRoomState, fakeUpgrades } from "./rooms";

/** Says which socket the room is handed as the server's end of the next upgrade. */
const serveNext = fakeUpgrades();

const { HarborRoom } = await import("../src/server/harbor-room");

class Socket extends HarborSocket {
  /** What kinds of message it has had, in order. */
  get kinds(): string[] {
    return this.sent.map((m) => m.type);
  }
  /** Everything it has had since `n` messages in. */
  since(n: number): HarborServerMessage[] {
    return this.sent.slice(n);
  }
  /** What it was told as it walked in. */
  get snapshot() {
    return this.sent[0] as Extract<HarborServerMessage, { type: "snapshot" }>;
  }
}

const CREW = "CREWAA";
const T0 = Date.UTC(2026, 10, 1, 12);
const MAP = generateHarbor();
// Three hexes east along the High Street: always open ground.
const along = { q: HARBOR_SPAWN.q + 3, r: HARBOR_SPAWN.r };

let sql: DatabaseSync;
let db: D1Database;
let state: ReturnType<typeof fakeRoomState<Socket>>;
let harbor: InstanceType<typeof HarborRoom>;

/** Someone walks into the Harbor: the upgrade request the worker passes on. `at`: where they ask to stand. */
async function enter(id: string, name: string, at?: string): Promise<Socket> {
  const ws = new Socket();
  serveNext(ws);
  const res = await harbor.fetch({
    url: `https://harbor/ws${at === undefined ? "" : `?at=${encodeURIComponent(at)}`}`,
    headers: new Headers({ Upgrade: "websocket", "x-crew-id": CREW, "x-player-id": id, "x-player-name": encodeURIComponent(name), "x-player-class": "cleric", "x-player-level": "1" }),
  } as never);
  if (res.status !== 101) throw new Error(`refused: ${await res.text()}`);
  return ws;
}

const tell = (ws: Socket, message: unknown) => harbor.webSocketMessage(ws as unknown as WebSocket, JSON.stringify(message));
const ask = (path: string, init: RequestInit = {}) => harbor.fetch(new Request(`https://harbor${path}`, { ...init, headers: { "x-crew-id": CREW } }));
const at = (ws: Socket) => ws.deserializeAttachment()?.pos;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  ({ sql, db } = openDb());
  addHero(sql, { id: "ann", name: "Ann", classId: "cleric", crew: CREW, at: T0 });
  addHero(sql, { id: "bob", name: "Bob", classId: "cleric", crew: CREW, at: T0 + 1 });
  state = fakeRoomState<Socket>();
  // The muster's alarm is the storage's too; nothing here sets one.
  Object.assign(state.ctx.storage, { setAlarm: async () => {}, getAlarm: async () => null, deleteAlarm: async () => {} });
  harbor = new HarborRoom(state.ctx as never, { DB: db } as never);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("walking into the Harbor", () => {
  it("tells whoever walks in who is here, the board and the muster, and tells the others they came and the board again", async () => {
    const ann = await enter("ann", "Ann");
    expect(ann.kinds).toEqual(["snapshot", "muster"]);
    expect(ann.snapshot).toMatchObject({ type: "snapshot", you: "ann", crew: { id: CREW, name: "Crew" }, members: [{ id: "ann", name: "Ann" }, { id: "bob", name: "Bob" }] });
    expect(ann.snapshot.players).toEqual([expect.objectContaining({ id: "ann", name: "Ann", classId: "cleric", level: 1, xp: 0, pos: HARBOR_SPAWN, vessel: null, gilded: false })]);
    expect(ann.sent[1]).toEqual({ type: "muster", muster: null });
    expect(state.sockets[0].tags).toEqual(["ann"]);

    const bob = await enter("bob", "Bob Ó");
    expect(bob.kinds).toEqual(["snapshot", "muster"]);
    expect(bob.snapshot.players).toMatchObject([{ id: "ann" }, { id: "bob", name: "Bob Ó", pos: HARBOR_SPAWN }]);
    // Ann hears of Bob once, with what the snapshot told him of himself, and is sent the board he was sent.
    const { type: _type, you: _you, crew: _crew, players: _players, ...board } = bob.snapshot;
    expect(ann.since(2)).toEqual([{ type: "joined", player: bob.snapshot.players[1] }, { type: "board", ...board }]);
  });

  it("shows a hero's boat and gilded rod to everyone, read as they walk in", async () => {
    sql.prepare("INSERT INTO furnishings (player_id, def_id, label, created_at) VALUES ('ann', 'float_barrel', 'Barrel', ?)").run(T0);
    const ann = await enter("ann", "Ann");
    expect(ann.snapshot.players[0]).toMatchObject({ id: "ann", vessel: "barrel", gilded: false });
    // And again when they say their gear has changed.
    sql.prepare("INSERT INTO furnishings (player_id, def_id, label, created_at) VALUES ('ann', 'rowboat', 'Rowboat', ?)").run(T0);
    sql.prepare("UPDATE characters SET level = 3 WHERE player_id = 'ann'").run();
    await tell(ann, { type: "refresh" });
    expect(ann.since(2)).toEqual([{ type: "joined", player: expect.objectContaining({ id: "ann", level: 3, vessel: "rowboat", pos: HARBOR_SPAWN }) }]);
    expect(ann.deserializeAttachment()).toMatchObject({ level: 3, vessel: "rowboat" });
  });

  it("answers only for a crew that exists, an upgrade, and a player", async () => {
    expect((await harbor.fetch(new Request("https://harbor/ws"))).status).toBe(400);
    expect((await ask("/ws")).status).toBe(426);
    const nobody = await harbor.fetch({ url: "https://harbor/ws", headers: new Headers({ Upgrade: "websocket", "x-crew-id": CREW }) } as never);
    expect([nobody.status, await nobody.text()]).toEqual([400, "missing player or crew"]);
    const nowhere = await harbor.fetch({ url: "https://harbor/ws", headers: new Headers({ Upgrade: "websocket", "x-crew-id": "NOCREW", "x-player-id": "ann" }) } as never);
    expect([nowhere.status, await nowhere.text()]).toEqual([400, "missing player or crew"]);
    expect(state.sockets).toEqual([]);
  });

  it("stands them at the door they stepped out of, or where they stood before if a hero could have walked there", async () => {
    expect(at(await enter("ann", "Ann", "pub"))).toEqual(HARBOR_PUB);
    await harbor.webSocketClose(state.sockets[0] as unknown as WebSocket, 1000);
    expect(at(await enter("ann", "Ann", "2"))).toEqual(HARBOR_PLOTS[2]);
    await harbor.webSocketClose(state.sockets[1] as unknown as WebSocket, 1000);
    expect(at(await enter("ann", "Ann", `${along.q},${along.r}`))).toEqual(along);
    await harbor.webSocketClose(state.sockets[2] as unknown as WebSocket, 1000);
    // Out at sea with no boat, a plot there is none of, and nonsense: where heroes arrive.
    const sea = MAP.tiles.find((t) => t.biome === "water" && harborPath(MAP, HARBOR_SPAWN, t, null) === null)!;
    for (const asked of [`${sea.q},${sea.r}`, "99", "the pub", ""]) {
      const ws = await enter("ann", "Ann", asked);
      expect(at(ws), asked).toEqual(HARBOR_SPAWN);
      await harbor.webSocketClose(ws as unknown as WebSocket, 1000);
    }
  });

  it("lets a newer tab take over, standing where the old one stood whatever it asked, without the player seeming to leave", async () => {
    const ann = await enter("ann", "Ann");
    const bob = await enter("bob", "Bob");
    await tell(ann, { type: "move", to: along });
    expect(at(ann)).toEqual(along);
    const heard = bob.sent.length;
    const tab = await enter("ann", "Ann", "pub");
    expect(ann.closed).toBe(4000);
    expect(ann.deserializeAttachment()).toBeNull();
    expect(tab.snapshot.players).toMatchObject([{ id: "bob" }, { id: "ann", pos: along }]);
    expect(bob.since(heard)).toMatchObject([{ type: "joined", player: { id: "ann", pos: along } }, { type: "board" }]);
    // The old socket's close arrives after: there is nobody behind it any more, so nobody is told anyone left.
    await harbor.webSocketClose(ann as unknown as WebSocket, 4000);
    expect(bob.since(heard)).toHaveLength(2);
    expect(tab.kinds).toEqual(["snapshot", "muster"]);
  });

  it("rubs out that they were out on a map, before the board is read for anyone", async () => {
    sql.prepare("INSERT INTO zone_presence (player_id, code, fighting, seen_at) VALUES ('ann', 'ZZZZ', 1, ?)").run(T0);
    const bob = await enter("bob", "Bob");
    expect(bob.snapshot.members).toMatchObject([{ id: "ann", zone: { code: "ZZZZ", fighting: true } }, { id: "bob" }]);
    const ann = await enter("ann", "Ann");
    expect(sql.prepare("SELECT 1 FROM zone_presence WHERE player_id = 'ann'").get()).toBeUndefined();
    expect(ann.snapshot.members[0]).not.toHaveProperty("zone");
    expect(bob.sent.at(-1)).toMatchObject({ type: "board" });
    expect((bob.sent.at(-1) as { members: object[] }).members[0]).not.toHaveProperty("zone");
  });
});

describe("in the Harbor", () => {
  let ann: Socket;
  let bob: Socket;
  let heard: [number, number];
  /** What each has been sent since the two of them were both in. */
  const news = () => [ann.since(heard[0]), bob.since(heard[1])];

  beforeEach(async () => {
    ann = await enter("ann", "Ann");
    bob = await enter("bob", "Bob");
    heard = [ann.sent.length, bob.sent.length];
  });

  it("says a line to everyone, the speaker too, tidied and cut to length", async () => {
    await tell(ann, { type: "say", text: "  ahoy \n\t there  ", name: "Bob", id: "bob" });
    await tell(ann, { type: "say", text: "   " });
    await tell(ann, { type: "say" });
    await tell(bob, { type: "say", text: "x".repeat(HARBOR_MAX_SAY + 50) });
    const said = [{ type: "said", id: "ann", name: "Ann", text: "ahoy there" }, { type: "said", id: "bob", name: "Bob", text: "x".repeat(HARBOR_MAX_SAY) }];
    expect(news()).toEqual([said, said]);
  });

  it("rolls a bedroll out where they stand for everyone to see, and up again when they walk off", async () => {
    await tell(ann, { type: "move", to: along });
    heard = [ann.sent.length, bob.sent.length];
    await tell(ann, { type: "bedroll" });
    const down = { type: "joined", player: expect.objectContaining({ id: "ann", pos: along, bedroll: along }) };
    expect(news()).toEqual([[down], [down]]);
    await tell(ann, { type: "move", to: HARBOR_SPAWN });
    expect(ann.deserializeAttachment()?.bedroll).toBeUndefined();
    expect(ann.deserializeAttachment()?.pos).toEqual(HARBOR_SPAWN);
    expect(news().map((n) => n.map((m) => m.type))).toEqual([["joined", "moved"], ["joined", "moved"]]);
  });

  it("drops what is not a message: too long, not text, not JSON, or from a socket a newer tab took over", async () => {
    await harbor.webSocketMessage(ann as unknown as WebSocket, JSON.stringify({ type: "say", text: "x".repeat(2000) }));
    await harbor.webSocketMessage(ann as unknown as WebSocket, "say hello");
    await harbor.webSocketMessage(ann as unknown as WebSocket, new ArrayBuffer(8));
    await tell(ann, { type: "dance" });
    await tell(ann, 5);
    const tab = await enter("ann", "Ann");
    heard = [ann.sent.length, bob.sent.length];
    await tell(ann, { type: "say", text: "still here?" });
    expect(news()).toEqual([[], []]);
    expect(tab.kinds).toEqual(["snapshot", "muster"]);
  });

  it("tells the others when someone leaves, and closes their socket with the code it closed with", async () => {
    await harbor.webSocketClose(bob as unknown as WebSocket, 1001);
    expect(bob.closed).toBe(1001);
    expect(news()).toEqual([[{ type: "left", id: "bob" }], []]);
    for (const [code, closedWith] of [[1005, 1000], [1006, 1000]]) {
      const again = await enter("bob", "Bob");
      await harbor.webSocketClose(again as unknown as WebSocket, code);
      expect(again.closed).toBe(closedWith);
    }
    const last = await enter("bob", "Bob");
    await harbor.webSocketError(last as unknown as WebSocket);
    expect(last.closed).toBe(1011);
    expect(ann.since(heard[0]).map((m) => m.type)).toEqual(["left", "joined", "board", "left", "joined", "board", "left", "joined", "board", "left"]);
    expect((await enter("bob", "Bob")).snapshot.players).toMatchObject([{ id: "ann" }, { id: "bob" }]);
  });

  it("says who is walking the Harbor, each once", async () => {
    await enter("bob", "Bob");
    expect(await (await ask("/present")).json()).toEqual({ ids: ["ann", "bob"] });
  });

  it("reads the board again for everyone here when told it changed, and for nobody when nobody is here", async () => {
    addHero(sql, { id: "cat", name: "Cat", classId: "cleric", crew: CREW, at: T0 + 2 });
    expect(await (await ask("/refresh")).text()).toBe("ok");
    const board = { type: "board", members: [expect.objectContaining({ id: "ann" }), expect.objectContaining({ id: "bob" }), expect.objectContaining({ id: "cat" })] };
    expect(news()).toMatchObject([[board], [board]]);
  });

  it("tells a player here, and only that player, that their trades changed", async () => {
    expect(await (await ask("/trades?to=bob&to=cat")).text()).toBe("ok");
    expect(news()).toEqual([[], [{ type: "trades" }]]);
  });

  it("shows XP over a hero who is here, and keeps their new level on their socket for whoever walks in later", async () => {
    const xp = { type: "xp", id: "ann", amount: 4, level: 3, xp: 12, levelsGained: 1 };
    expect(await (await harbor.fetch(new Request("https://harbor/xp", { method: "POST", headers: { "x-crew-id": CREW }, body: JSON.stringify(xp) }))).text()).toBe("ok");
    expect(news()).toEqual([[xp], [xp]]);
    expect(ann.deserializeAttachment()).toMatchObject({ id: "ann", level: 3, xp: 12, pos: HARBOR_SPAWN });
    await harbor.fetch(new Request("https://harbor/xp", { method: "POST", headers: { "x-crew-id": CREW }, body: JSON.stringify({ ...xp, id: "cat" }) }));
    expect(news()).toEqual([[xp], [xp]]);
  });
});
