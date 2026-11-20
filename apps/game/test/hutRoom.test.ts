// Who is in a hut, as HutRoom keeps it: the owner and a visiting crewmate walking in, a newer tab taking over,
// walking, getting up out of bed, looking, getting unstuck, talking and leaving. The room is driven the way the
// worker drives it (the upgrade request `enterHut` passes on, then the socket's messages), with fake hibernatable
// sockets and the runtime's side of a room (rooms.ts), against a real SQLite database with the game's migrations
// applied (d1.ts).

import type { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HARBOR_MAX_SAY, HOME_FREEBIES, LOOK_MIN_MS, UNSTICK_COOLDOWN_MS, hutDoor, hutPath, hutRoom, type Furnishing, type HarborPlayer, type HutServerMessage } from "@gantt-quest/world";
import { addHero, openDb } from "./d1";
import { FakeSocket, fakeRoomState, fakeUpgrades } from "./rooms";

/** Says which socket the room is handed as the server's end of the next upgrade. */
const serveNext = fakeUpgrades();

const { HutRoom } = await import("../src/server/hut-room");

class HutSocket extends FakeSocket<HutServerMessage, HarborPlayer> {
  /** What kinds of message it has had, in order. */
  get kinds(): string[] {
    return this.sent.map((m) => m.type);
  }
  /** Everything it has had since `n` messages in. */
  since(n: number): HutServerMessage[] {
    return this.sent.slice(n);
  }
  /** The furniture it was told of as it walked in. */
  get furnishings(): Furnishing[] {
    return (this.sent[0] as Extract<HutServerMessage, { type: "snapshot" }>).furnishings;
  }
}

const CREW = "CREWAA";
const T0 = Date.UTC(2026, 10, 1, 12);
const DOOR = hutDoor(1);
const ROOM = hutRoom(1);

let sql: DatabaseSync;
let db: D1Database;
let state: ReturnType<typeof fakeRoomState<HutSocket>>;
let hut: InstanceType<typeof HutRoom>;

/** Ann's hut, as the runtime would hand it over: fresh in memory, with whatever sockets outlived the last one. */
const room = () => new HutRoom(state.ctx as never, { DB: db } as never);

/** Someone walks into Ann's hut: the upgrade request the worker passes on. */
async function enter(id: string, name: string, to = hut): Promise<HutSocket> {
  const ws = new HutSocket();
  serveNext(ws);
  const res = await to.fetch({
    url: "https://hut/ws",
    headers: new Headers({ Upgrade: "websocket", "x-hut-owner": "ann", "x-hut-owner-name": "Ann", "x-player-id": id, "x-player-name": encodeURIComponent(name), "x-player-class": "cleric", "x-player-level": "1" }),
  } as never);
  if (res.status !== 101) throw new Error(`refused: ${await res.text()}`);
  return ws;
}

const tell = (ws: HutSocket, message: unknown, to = hut) => to.webSocketMessage(ws as unknown as WebSocket, typeof message === "string" ? message : JSON.stringify(message));
const ask = (path: string, init: RequestInit = {}) => hut.fetch(new Request(`https://hut${path}`, { ...init, headers: { "x-hut-owner": "ann", ...(init.headers as Record<string, string> | undefined) } }));
const at = (ws: HutSocket) => ws.deserializeAttachment()?.pos;
/** Somewhere across the floor that can be walked to from the door, round the furniture: the far end of the longest such walk. */
function across(furnishings: Furnishing[], from = DOOR) {
  const walks = ROOM.tiles.flatMap((t) => {
    const path = hutPath(ROOM, furnishings, from, { q: t.q, r: t.r }, undefined, [from]);
    return path ? [path] : [];
  });
  const path = walks.sort((a, b) => b.length - a.length)[0];
  return { to: path[path.length - 1], path };
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(T0);
  ({ sql, db } = openDb());
  addHero(sql, { id: "ann", name: "Ann", classId: "cleric", crew: CREW, at: T0 });
  addHero(sql, { id: "bob", name: "Bob", classId: "cleric", crew: CREW, at: T0 });
  state = fakeRoomState<HutSocket>();
  hut = room();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("walking into a hut", () => {
  it("gives the owner their first furniture, tells them what is here and that it is theirs to move", async () => {
    const ann = await enter("ann", "Ann");
    expect(ann.sent).toEqual([
      { type: "snapshot", you: "ann", owner: { id: "ann", name: "Ann" }, tier: 1, canEdit: true, players: [expect.objectContaining({ id: "ann", name: "Ann", classId: "cleric", level: 1, xp: 0, pos: DOOR })], furnishings: expect.any(Array) },
    ]);
    expect(ann.furnishings.map((f) => f.defId).sort()).toEqual(["table", "chair", "rug", ...HOME_FREEBIES].sort());
    // Every socket here carries its player's id and the hut's owner.
    expect(state.sockets[0].tags).toEqual(["ann", "owner:ann"]);
  });

  it("lets a crewmate in to look, standing in the door, and tells whoever is here that they came", async () => {
    const ann = await enter("ann", "Ann");
    const bob = await enter("bob", "Bob");
    expect(bob.sent).toMatchObject([{ type: "snapshot", you: "bob", owner: { id: "ann", name: "Ann" }, tier: 1, canEdit: false, players: [{ id: "ann" }, { id: "bob", name: "Bob", pos: DOOR }] }]);
    expect(bob.furnishings).toEqual(ann.furnishings);
    expect(ann.since(1)).toEqual([{ type: "joined", player: (bob.sent[0] as { players: HarborPlayer[] }).players[1] }]);
    // A visitor is given nothing, and may move nothing.
    await tell(bob, { type: "pick_up", id: ann.furnishings[0].id });
    expect(bob.since(1)).toEqual([{ type: "refused", reason: "Only the owner can move the furniture." }]);
  });

  it("answers only for a hut, an upgrade, and a player", async () => {
    expect((await hut.fetch(new Request("https://hut/ws"))).status).toBe(400);
    expect((await ask("/ws")).status).toBe(426);
    const res = await hut.fetch({ url: "https://hut/ws", headers: new Headers({ Upgrade: "websocket", "x-hut-owner": "ann" }) } as never);
    expect([res.status, await res.text()]).toEqual([400, "missing player"]);
  });

  it("lets a newer tab take over, standing where the old one stood, without the player seeming to leave", async () => {
    const ann = await enter("ann", "Ann");
    const bob = await enter("bob", "Bob");
    const { to } = across(ann.furnishings);
    await tell(bob, { type: "move", to });
    expect(at(bob)).toEqual(to);
    const heard = ann.sent.length;
    const tab = await enter("bob", "Bob");
    expect(bob.closed).toBe(4000);
    expect(bob.deserializeAttachment()).toBeNull();
    expect(tab.sent[0]).toMatchObject({ type: "snapshot", you: "bob", players: [{ id: "ann" }, { id: "bob", pos: to }] });
    expect(ann.since(heard)).toMatchObject([{ type: "joined", player: { id: "bob", pos: to } }]);
    await hut.webSocketClose(bob as unknown as WebSocket, 4000);
    expect(ann.since(heard)).toHaveLength(1);
  });

  it("says whether a player is standing in the hut", async () => {
    await enter("ann", "Ann");
    expect(await (await ask("/present", { headers: { "x-player-id": "ann" } })).text()).toBe("yes");
    expect(await (await ask("/present", { headers: { "x-player-id": "bob" } })).text()).toBe("no");
    expect(await (await ask("/present")).text()).toBe("no");
  });
});

describe("in a hut", () => {
  let ann: HutSocket;
  let bob: HutSocket;
  let heard: [number, number];
  /** What each has been sent since the two of them were both in. */
  const news = () => [ann.since(heard[0]), bob.since(heard[1])];

  beforeEach(async () => {
    ann = await enter("ann", "Ann");
    bob = await enter("bob", "Bob");
    heard = [ann.sent.length, bob.sent.length];
  });

  it("relays a walk to everyone, the walker too, and remembers where it ended", async () => {
    const { to, path } = across(ann.furnishings);
    await tell(bob, { type: "move", to });
    expect(news()).toEqual([[{ type: "moved", id: "bob", path }], [{ type: "moved", id: "bob", path }]]);
    expect(at(bob)).toEqual(to);
    // A room woken from hibernation reads the hut again and walks them on from where the socket says they stand.
    const woken = room();
    await tell(bob, { type: "move", to: DOOR }, woken);
    expect(bob.sent.at(-1)).toEqual({ type: "moved", id: "bob", path: hutPath(ROOM, ann.furnishings, to, DOOR, undefined, [DOOR])! });
  });

  it("makes no walk, and says nothing, where there is no way or no hex", async () => {
    for (const to of [{ q: 99, r: 99 }, "the bed", null, { q: 1.5, r: 2 }, { q: DOOR.q, r: DOOR.r }]) await tell(bob, { type: "move", to });
    await tell(bob, { type: "move" });
    expect(news()).toEqual([[], []]);
    expect(at(bob)).toEqual(DOOR);
  });

  it("gets someone lying in bed up when they walk off, for everyone to see", async () => {
    ann.serializeAttachment({ ...ann.deserializeAttachment()!, bed: 7 });
    const { to, path } = across(ann.furnishings);
    await tell(ann, { type: "move", to });
    expect(ann.deserializeAttachment()).toMatchObject({ id: "ann", pos: to });
    expect(ann.deserializeAttachment()?.bed).toBeUndefined();
    const up = [{ type: "moved", id: "ann", path }, { type: "joined", player: expect.objectContaining({ id: "ann", pos: to }) }];
    expect(news()).toEqual([up, up]);
    expect(bob.sent.at(-1)).not.toHaveProperty("player.bed");
    // Someone on their feet just walks.
    await tell(ann, { type: "move", to: across(ann.furnishings, to).to });
    expect(bob.sent.at(-1)).toMatchObject({ type: "moved", id: "ann" });
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
    const { to } = across(ann.furnishings);
    await tell(bob, { type: "move", to });
    heard = [ann.sent.length, bob.sent.length];
    await tell(bob, { type: "unstick", id: "ann" });
    expect(at(bob)).toEqual(DOOR);
    expect(news()).toEqual([[{ type: "placed", id: "bob", pos: DOOR }], [{ type: "placed", id: "bob", pos: DOOR }]]);
    // Walk off and ask again straight away: dropped. Ann is not held up by Bob's limit.
    await tell(bob, { type: "move", to });
    vi.setSystemTime(T0 + UNSTICK_COOLDOWN_MS - 1);
    await tell(bob, { type: "unstick" });
    expect(at(bob)).toEqual(to);
    heard = [ann.sent.length, bob.sent.length];
    await tell(ann, { type: "unstick" });
    expect(news()).toEqual([[{ type: "placed", id: "ann", pos: DOOR }], [{ type: "placed", id: "ann", pos: DOOR }]]);
    vi.setSystemTime(T0 + UNSTICK_COOLDOWN_MS);
    await tell(bob, { type: "unstick" });
    expect(at(bob)).toEqual(DOOR);
  });

  it("says a line to everyone, the speaker too, tidied and cut to length", async () => {
    await tell(bob, { type: "say", text: "  nice \n\t rug  ", name: "Ann", id: "ann" });
    await tell(bob, { type: "say", text: "   " });
    await tell(bob, { type: "say" });
    await tell(ann, { type: "say", text: "x".repeat(HARBOR_MAX_SAY + 50) });
    const said = [{ type: "said", id: "bob", name: "Bob", text: "nice rug" }, { type: "said", id: "ann", name: "Ann", text: "x".repeat(HARBOR_MAX_SAY) }];
    expect(news()).toEqual([said, said]);
  });

  it("shows a hero's new look to everyone when they say it has changed", async () => {
    sql.prepare("UPDATE characters SET name = 'Annie', level = 4 WHERE player_id = 'ann'").run();
    await tell(ann, { type: "refresh" });
    const joined = { type: "joined", player: expect.objectContaining({ id: "ann", name: "Annie", level: 4, pos: DOOR }) };
    expect(news()).toEqual([[joined], [joined]]);
    expect(ann.deserializeAttachment()).toMatchObject({ name: "Annie", level: 4, pos: DOOR });
  });

  it("drops what is not a message: too long, not text, not JSON, or from a socket a newer tab took over", async () => {
    await tell(bob, JSON.stringify({ type: "say", text: "x".repeat(2000) }));
    await tell(bob, "say hello");
    await hut.webSocketMessage(bob as unknown as WebSocket, new ArrayBuffer(8));
    await tell(bob, { type: "dance" });
    await tell(bob, 5);
    const tab = await enter("bob", "Bob");
    heard = [ann.sent.length, bob.sent.length];
    await tell(bob, { type: "say", text: "still here?" });
    expect(news()).toEqual([[], []]);
    expect(tab.kinds).toEqual(["snapshot"]);
  });

  it("tells the others when someone leaves, and closes their socket with the code it closed with", async () => {
    await hut.webSocketClose(bob as unknown as WebSocket, 1001);
    expect(bob.closed).toBe(1001);
    expect(news()).toEqual([[{ type: "left", id: "bob" }], []]);
    for (const [code, closedWith] of [[1005, 1000], [1006, 1000]]) {
      const again = await enter("bob", "Bob");
      await hut.webSocketClose(again as unknown as WebSocket, code);
      expect(again.closed).toBe(closedWith);
    }
    const last = await enter("bob", "Bob");
    await hut.webSocketError(last as unknown as WebSocket);
    expect(last.closed).toBe(1011);
    expect(ann.since(heard[0]).map((m) => m.type)).toEqual(["left", "joined", "left", "joined", "left", "joined", "left"]);
    expect((await enter("bob", "Bob")).sent[0]).toMatchObject({ players: [{ id: "ann" }, { id: "bob" }] });
  });

  it("shows XP over a hero who is here, and keeps their new level on their socket for whoever walks in later", async () => {
    const xp = { type: "xp", id: "bob", amount: 4, level: 3, xp: 12, levelsGained: 1 };
    expect(await (await ask("/xp", { method: "POST", body: JSON.stringify(xp) })).text()).toBe("ok");
    expect(news()).toEqual([[xp], [xp]]);
    expect(bob.deserializeAttachment()).toMatchObject({ id: "bob", level: 3, xp: 12, pos: DOOR });
    await ask("/xp", { method: "POST", body: JSON.stringify({ ...xp, id: "cat" }) });
    await ask("/xp", { method: "POST", body: "not json" });
    expect(news()).toEqual([[xp], [xp]]);
  });

  it("reads the hut again when it changed from outside, and tells everyone here", async () => {
    sql.prepare("INSERT INTO furnishings (player_id, def_id, label, created_at) VALUES ('ann', 'chair', 'Chair', ?)").run(T0);
    expect(await (await ask("/refresh")).text()).toBe("ok");
    const told = ann.since(heard[0]);
    expect(told).toMatchObject([{ type: "furnishings", tier: 1 }]);
    expect((told[0] as { furnishings: Furnishing[] }).furnishings).toHaveLength(ann.furnishings.length + 1);
    expect(bob.since(heard[1])).toEqual(told);
  });
});
