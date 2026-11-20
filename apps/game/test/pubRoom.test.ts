// Who is in the pub, as PubRoom keeps it: walking in, a newer tab taking over, walking, looking, getting
// unstuck, talking and leaving, and the game tables being reached by their names. The room is driven the way
// the worker drives it (the upgrade request `enterPub` passes on, then the socket's messages), with fake
// hibernatable sockets and the runtime's side of a room (rooms.ts), against a real SQLite database with the
// game's migrations applied (d1.ts). The tables' own rules are in stakes.test.ts and pubScores.test.ts.

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARBOR_MAX_SAY, LOOK_MIN_MS, PUB_DICE, PUB_SEATS, UNSTICK_COOLDOWN_MS, pubPath, pubRoom, type HarborPlayer, type PubServerMessage } from "@gantt-quest/world";
import { addHero, openDb } from "./d1";
import { FakeSocket, fakeRoomState, fakeUpgrades } from "./rooms";

/** Says which socket the room is handed as the server's end of the next upgrade. */
const serveNext = fakeUpgrades();

const { PubRoom } = await import("../src/server/pub-room");

class PubSocket extends FakeSocket<PubServerMessage, HarborPlayer> {
  /** What kinds of message it has had, in order. */
  get kinds(): string[] {
    return this.sent.map((m) => m.type);
  }
  /** Everything it has had since `n` messages in. */
  since(n: number): PubServerMessage[] {
    return this.sent.slice(n);
  }
}

const CREW = "CREWAA";
const ROOM = pubRoom();
const DOOR = ROOM.pois.find((p) => p.kind === "door")!.pos;
const T0 = Date.UTC(2026, 10, 1, 12);

let sql: DatabaseSync;
let db: D1Database;
let state: ReturnType<typeof fakeRoomState<PubSocket>>;
let pub: InstanceType<typeof PubRoom>;

/** A room as the runtime would hand it over: fresh in memory, with whatever sockets and storage outlived the last one. */
async function room() {
  const made = new PubRoom(state.ctx as never, { DB: db } as never);
  await state.ready;
  return made;
}

/** Someone walks into the pub: the upgrade request the worker passes on. */
async function enter(id: string, name = id, to = pub): Promise<PubSocket> {
  const ws = new PubSocket();
  serveNext(ws);
  const res = await to.fetch({
    url: "https://pub/ws",
    headers: new Headers({ Upgrade: "websocket", "x-player-id": id, "x-player-name": encodeURIComponent(name), "x-player-class": "cleric", "x-player-level": "1", "x-crew-id": CREW }),
  } as never);
  if (res.status !== 101) throw new Error(`refused: ${await res.text()}`);
  return ws;
}

const tell = (ws: PubSocket, message: unknown, to = pub) => to.webSocketMessage(ws as unknown as WebSocket, typeof message === "string" ? message : JSON.stringify(message));
const post = (path: string, body: unknown) => pub.fetch(new Request(`https://pub${path}`, { method: "POST", body: JSON.stringify(body) }));
const at = (ws: PubSocket) => ws.deserializeAttachment()?.pos;

beforeEach(async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  ({ sql, db } = openDb());
  addHero(sql, { id: "ann", name: "Ann", classId: "cleric", crew: CREW, at: T0 });
  addHero(sql, { id: "bob", name: "Bob", classId: "cleric", crew: CREW, at: T0 });
  state = fakeRoomState<PubSocket>();
  pub = await room();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("walking into the pub", () => {
  it("tells whoever walks in who is here and then each table in turn, and tells the others they came", async () => {
    const ann = await enter("ann", "Ann");
    expect(ann.sent).toEqual([
      { type: "snapshot", you: "ann", players: [expect.objectContaining({ id: "ann", name: "Ann", classId: "cleric", level: 1, xp: 0, pos: DOOR })] },
      { type: "dice", table: null },
      { type: "shoals", table: null },
      { type: "crew", table: null },
      { type: "tide", table: null },
    ]);
    expect(state.sockets[0].tags).toEqual(["ann"]);
    const bob = await enter("bob", "Bob Ó");
    expect(bob.sent[0]).toMatchObject({ type: "snapshot", you: "bob", players: [{ id: "ann" }, { id: "bob", name: "Bob Ó", pos: DOOR }] });
    expect(bob.kinds).toEqual(["snapshot", "dice", "shoals", "crew", "tide"]);
    // Ann hears of Bob once, with what the snapshot told him of himself; Bob is not told of himself again.
    expect(ann.since(5)).toEqual([{ type: "joined", player: (bob.sent[0] as { players: HarborPlayer[] }).players[1] }]);
  });

  it("answers only an upgrade, from a player", async () => {
    expect((await pub.fetch(new Request("https://pub/ws", { headers: { "x-player-id": "ann" } }))).status).toBe(426);
    const res = await pub.fetch({ url: "https://pub/ws", headers: new Headers({ Upgrade: "websocket" }) } as never);
    expect([res.status, await res.text()]).toEqual([400, "missing player"]);
    expect(state.sockets).toEqual([]);
  });

  it("lets a newer tab take over, standing where the old one stood, without the player seeming to leave", async () => {
    const ann = await enter("ann");
    const bob = await enter("bob");
    await tell(ann, { type: "move", to: PUB_DICE });
    expect(at(ann)).toEqual(PUB_DICE);
    const heard = bob.sent.length;
    const tab = await enter("ann");
    expect(ann.closed).toBe(4000);
    expect(ann.deserializeAttachment()).toBeNull();
    expect(tab.sent[0]).toMatchObject({ type: "snapshot", you: "ann", players: [{ id: "bob" }, { id: "ann", pos: PUB_DICE }] });
    expect(bob.since(heard)).toMatchObject([{ type: "joined", player: { id: "ann", pos: PUB_DICE } }]);
    // The old socket's close arrives after: there is nobody behind it any more, so nobody is told anyone left.
    await pub.webSocketClose(ann as unknown as WebSocket, 4000);
    expect(bob.since(heard)).toHaveLength(1);
    expect(tab.kinds).not.toContain("left");
  });

  it("remembers whose pub it is, for a room woken with no memory of it", async () => {
    await enter("ann");
    expect(state.storage.get("crewId")).toBe(CREW);
  });
});

describe("in the pub", () => {
  let ann: PubSocket;
  let bob: PubSocket;
  let heard: [number, number];
  /** What each has been sent since the two of them were both in. */
  const news = () => [ann.since(heard[0]), bob.since(heard[1])];

  beforeEach(async () => {
    ann = await enter("ann", "Ann");
    bob = await enter("bob", "Bob");
    heard = [ann.sent.length, bob.sent.length];
  });

  it("relays a walk to everyone, the walker too, and remembers where it ended", async () => {
    const path = pubPath(ROOM, DOOR, PUB_DICE, [DOOR])!;
    await tell(ann, { type: "move", to: PUB_DICE });
    expect(news()).toEqual([[{ type: "moved", id: "ann", path }], [{ type: "moved", id: "ann", path }]]);
    expect(at(ann)).toEqual(PUB_DICE);
    // A room woken from hibernation walks them on from there: where they stand is on the socket.
    const woken = await room();
    await tell(ann, { type: "move", to: DOOR }, woken);
    expect(ann.sent.at(-1)).toEqual({ type: "moved", id: "ann", path: pubPath(ROOM, PUB_DICE, DOOR, [DOOR])! });
  });

  it("makes no walk, and says nothing, where there is no way or no hex", async () => {
    // Behind the bar is the barkeep's; a wall is a wall; and what is not a hex is not a walk.
    for (const to of [{ q: 0, r: 0 }, { q: 99, r: 99 }, "the bar", null, { q: 1.5, r: 2 }, { q: DOOR.q, r: DOOR.r }]) await tell(ann, { type: "move", to });
    await tell(ann, { type: "move" });
    expect(news()).toEqual([[], []]);
    expect(at(ann)).toEqual(DOOR);
  });

  it("lets one sit on a stool, and nobody else walk onto it while they do", async () => {
    const stool = PUB_SEATS.find((s) => pubPath(ROOM, DOOR, s, [])) as { q: number; r: number };
    await tell(bob, { type: "move", to: stool });
    expect(at(bob)).toEqual(stool);
    await tell(ann, { type: "move", to: stool });
    expect(at(ann)).toEqual(DOOR);
    expect(ann.since(heard[0]).filter((m) => m.type === "moved")).toHaveLength(1);
  });

  it("passes a look on to everyone else, at most one per LOOK_MIN_MS from each player, and keeps none of it", async () => {
    const before = JSON.stringify(ann.deserializeAttachment());
    await tell(ann, { type: "look", look: 5, id: "bob" });
    vi.setSystemTime(T0 + LOOK_MIN_MS - 1);
    await tell(ann, { type: "look", look: 6 });
    await tell(bob, { type: "look", look: 9 });
    vi.setSystemTime(T0 + LOOK_MIN_MS);
    await tell(ann, { type: "look", look: 7 });
    for (const bad of [-1, 2.5, "4", null, 32]) await tell(bob, { type: "look", look: bad });
    expect(news()).toEqual([[{ type: "looked", id: "bob", look: 9 }], [{ type: "looked", id: "ann", look: 5 }, { type: "looked", id: "ann", look: 7 }]]);
    expect(JSON.stringify(ann.deserializeAttachment())).toBe(before);
  });

  it("puts a stuck hero back at the door, their own only, at most once per cooldown", async () => {
    await tell(ann, { type: "move", to: PUB_DICE });
    await tell(bob, { type: "move", to: PUB_DICE });
    heard = [ann.sent.length, bob.sent.length];
    await tell(ann, { type: "unstick", id: "bob" });
    expect(at(ann)).toEqual(DOOR);
    expect(at(bob)).toEqual(PUB_DICE);
    expect(news()).toEqual([[{ type: "placed", id: "ann", pos: DOOR }], [{ type: "placed", id: "ann", pos: DOOR }]]);
    // Walk off and ask again straight away: dropped. Bob is not held up by Ann's limit.
    await tell(ann, { type: "move", to: PUB_DICE });
    vi.setSystemTime(T0 + UNSTICK_COOLDOWN_MS - 1);
    await tell(ann, { type: "unstick" });
    expect(at(ann)).toEqual(PUB_DICE);
    await tell(bob, { type: "unstick" });
    expect(at(bob)).toEqual(DOOR);
    vi.setSystemTime(T0 + UNSTICK_COOLDOWN_MS);
    await tell(ann, { type: "unstick" });
    expect(at(ann)).toEqual(DOOR);
  });

  it("says a line to everyone, the speaker too, tidied and cut to length", async () => {
    await tell(ann, { type: "say", text: "  ahoy \n\t there  ", name: "Bob", id: "bob" });
    await tell(ann, { type: "say", text: "   " });
    await tell(ann, { type: "say" });
    await tell(bob, { type: "say", text: "x".repeat(HARBOR_MAX_SAY + 50) });
    const said = [{ type: "said", id: "ann", name: "Ann", text: "ahoy there" }, { type: "said", id: "bob", name: "Bob", text: "x".repeat(HARBOR_MAX_SAY) }];
    expect(news()).toEqual([said, said]);
  });

  it("drops what is not a message: too long, not text, not JSON, or from a socket a newer tab took over", async () => {
    await tell(ann, JSON.stringify({ type: "say", text: "x".repeat(2000) }));
    await tell(ann, "say hello");
    await pub.webSocketMessage(ann as unknown as WebSocket, new ArrayBuffer(8));
    await tell(ann, { type: "dance" });
    await tell(ann, { type: "constructor", action: { type: "open" } });
    await tell(ann, 5);
    const tab = await enter("ann");
    heard = [ann.sent.length, bob.sent.length];
    await tell(ann, { type: "say", text: "still here?" });
    expect(news()).toEqual([[], []]);
    expect(tab.kinds).not.toContain("said");
  });

  it("tells the others when someone leaves, and closes their socket with the code it closed with", async () => {
    await pub.webSocketClose(bob as unknown as WebSocket, 1001);
    expect(bob.closed).toBe(1001);
    expect(news()).toEqual([[{ type: "left", id: "bob" }], []]);
    // No code at all (1005), a dropped connection (1006) and an error (1011) are closed too, with a code that may be sent.
    for (const [code, closedWith] of [[1005, 1000], [1006, 1000]]) {
      const again = await enter("bob");
      await pub.webSocketClose(again as unknown as WebSocket, code);
      expect(again.closed).toBe(closedWith);
    }
    const last = await enter("bob");
    await pub.webSocketError(last as unknown as WebSocket);
    expect(last.closed).toBe(1011);
    expect(ann.since(heard[0]).map((m) => m.type)).toEqual(["left", "joined", "left", "joined", "left", "joined", "left"]);
    // Whoever walks in next is not told of anyone who has gone.
    expect((await enter("bob")).sent[0]).toMatchObject({ players: [{ id: "ann" }, { id: "bob" }] });
  });

  it("shows XP over a hero who is here, and keeps their new level on their socket for whoever walks in later", async () => {
    const xp = { type: "xp", id: "ann", amount: 4, level: 3, xp: 12, levelsGained: 1 };
    expect(await (await post("/xp", { ...xp, amount: 4.9, extra: true })).text()).toBe("ok");
    expect(news()).toEqual([[xp], [xp]]);
    expect(ann.deserializeAttachment()).toMatchObject({ id: "ann", level: 3, xp: 12, pos: DOOR });
    // Someone who is not here, and something that is no award: nothing.
    await post("/xp", { ...xp, id: "cat" });
    await post("/xp", { type: "gold", id: "ann" });
    expect(news()).toEqual([[xp], [xp]]);
  });

  it("hangs a word with the barkeep over the speaker, for everyone here", async () => {
    await post("/bubble", { id: "ann", text: "  a pint,\n please " });
    await post("/bubble", { id: "ann", text: " " });
    await post("/bubble", { text: "nobody said this" });
    const bubble = { type: "bubble", id: "ann", text: "a pint, please" };
    expect(news()).toEqual([[bubble], [bubble]]);
  });

  it("takes a game's messages to that game's table, and gives up a seat there on walking or being put away", async () => {
    // Not at the table: the table as it stands, then the refusal, to the one who asked.
    await tell(ann, { type: "shoals", action: { type: "open", ante: 0 } });
    expect(news()).toEqual([[{ type: "shoals", table: null }, { type: "shoalsError", text: "Walk up to the table first." }], [{ type: "shoals", table: null }]]);
    await tell(ann, { type: "move", to: PUB_DICE });
    heard = [ann.sent.length, bob.sent.length];
    await tell(ann, { type: "dice", action: { type: "open", ante: 0 } });
    expect(news()).toMatchObject([[{ type: "dice", table: { phase: "open", ante: 0 } }], [{ type: "dice", table: { phase: "open", ante: 0 } }]]);
    // A game's name with nothing asked of it, and something that is no request of that game's: dropped.
    await tell(ann, { type: "dice" });
    await tell(ann, { type: "dice", action: { type: "cheat" } });
    expect(news().map((n) => n.length)).toEqual([1, 1]);
    // Someone walking in while it is open is shown it, in the tables' order.
    addHero(sql, { id: "cat", name: "Cat", classId: "cleric", crew: CREW, at: T0 });
    const cat = await enter("cat");
    expect(cat.sent.slice(1)).toMatchObject([{ type: "dice", table: { phase: "open" } }, { type: "shoals", table: null }, { type: "crew", table: null }, { type: "tide", table: null }]);
    // Put back at the door, Ann is no longer at the table: her seat is given up, and the empty table cleared away.
    heard = [ann.sent.length, bob.sent.length];
    await tell(ann, { type: "unstick" });
    expect(news()).toEqual([[{ type: "placed", id: "ann", pos: DOOR }, { type: "dice", table: null }], [{ type: "placed", id: "ann", pos: DOOR }, { type: "dice", table: null }]]);
    // The same on walking away, and on leaving the pub.
    await tell(bob, { type: "move", to: PUB_DICE });
    await tell(bob, { type: "dice", action: { type: "open", ante: 0 } });
    heard = [ann.sent.length, bob.sent.length];
    await tell(bob, { type: "move", to: DOOR });
    expect(ann.since(heard[0]).map((m) => m.type)).toEqual(["moved", "dice"]);
    await tell(bob, { type: "move", to: PUB_DICE });
    await tell(bob, { type: "dice", action: { type: "open", ante: 0 } });
    heard = [ann.sent.length, bob.sent.length];
    await pub.webSocketClose(bob as unknown as WebSocket, 1000);
    expect(news()).toEqual([[{ type: "left", id: "bob" }, { type: "dice", table: null }], []]);
  });
});
