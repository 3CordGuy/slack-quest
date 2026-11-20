// What a ZoneRoom tells the crew's Harbor, whose notice board shows where each member is and their level: that
// there is news, once for each thing done on the map, however many heroes it is news of. Driven as zoneRoom.test.ts
// drives the room, with a stand-in for the Harbor's room that counts how often it is asked to read its board again.

import type { DatabaseSync } from "node:sqlite";
import { beforeEach, describe, expect, it } from "vitest";
import { zoneOptions, type ZoneView } from "@gantt-quest/world";
import { createZoneRow } from "../src/server/zones";
import { addHero, openDb } from "./d1";
import { FakeSocket as RoomSocket, fakeRoomState, fakeUpgrades } from "./rooms";

/** Says which socket the room is handed as the server's end of the next upgrade. */
const serveNext = fakeUpgrades();

const { ZoneRoom } = await import("../src/server/zone-room");

type Update = { type: "update"; state: ZoneView } | { type: "error"; message: string };
class FakeSocket extends RoomSocket<Update, { playerId: string }> {
  /** The newest state this socket was sent. */
  get state(): ZoneView {
    const last = this.sent.filter((m): m is Extract<Update, { type: "update" }> => m.type === "update").at(-1);
    if (!last) throw new Error("nothing sent yet");
    return last.state;
  }
}

const CREW = "CREWAA";

let sql: DatabaseSync;
let db: D1Database;
let state: ReturnType<typeof fakeRoomState<FakeSocket>>;
let zone: InstanceType<typeof ZoneRoom>;
/** Each time a crew's Harbor was asked to read its board again: the crew. */
let refreshed: string[];
/** Everything the room left running behind what it answered. */
let behind: Promise<unknown>[];

/** How many times the Harbor was told there was news while `fn` ran, once everything left running has finished. */
async function told(fn: () => Promise<unknown>): Promise<string[]> {
  await Promise.all(behind);
  refreshed = [];
  await fn();
  await Promise.all(behind);
  return refreshed;
}

async function connect(code: string, playerId: string): Promise<FakeSocket> {
  const ws = new FakeSocket();
  serveNext(ws);
  const res = await zone.fetch({ headers: new Headers({ Upgrade: "websocket", "x-zone-code": code, "x-player-id": playerId }) } as never);
  if (res.status !== 101) throw new Error(`refused: ${await res.text()}`);
  return ws;
}

const act = (ws: FakeSocket, action: Record<string, unknown>) => zone.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "action", action }));
const presence = (id: string) => sql.prepare("SELECT code, fighting FROM zone_presence WHERE player_id = ?").get(id) as { code: string; fighting: number } | undefined;

beforeEach(() => {
  ({ sql, db } = openDb());
  const at = Date.now();
  for (const [id, name] of [["ann", "Ann"], ["bo", "Bo"], ["cy", "Cy"]]) addHero(sql, { id, name, str: 9, int_stat: 4, vit: 9, agi: 4, dex: 4, crew: CREW, at });
  // Dee is in no crew: there is no Harbor to tell of her.
  addHero(sql, { id: "dee", name: "Dee", str: 9, int_stat: 4, vit: 9, agi: 4, dex: 4, at });
  refreshed = [];
  behind = [];
  state = fakeRoomState<FakeSocket>();
  // The zone room finds a socket by its player's id, which is its one tag, and sets a turn's alarm.
  let alarm: number | null = null;
  Object.assign(state.ctx, { waitUntil: (p: Promise<unknown>) => void behind.push(p) });
  Object.assign(state.ctx.storage, { setAlarm: async (at: number) => void (alarm = at), getAlarm: async () => alarm, deleteAlarm: async () => void (alarm = null) });
  const harbors = {
    idFromName: (crew: string) => crew,
    get: (crew: string) => ({
      async fetch(url: string) {
        if (new URL(url).pathname === "/refresh") refreshed.push(crew);
        return new Response("ok");
      },
    }),
  };
  zone = new ZoneRoom(state.ctx as never, { DB: db, ENVIRONMENT: "dev", HARBOR_ROOM: harbors } as never);
});

describe("ZoneRoom and the crew's Harbor", () => {
  it("tells the Harbor once when someone walks onto the map, and once when they leave it", async () => {
    const code = await createZoneRow(db, "ann", zoneOptions({ size: "small", biome: "meadow", groups: 1, kinds: ["wolf"], elevation: 0, obstacles: 0, clear: 3, party: 3 }), "harbor-news");
    let ann!: FakeSocket;
    expect(await told(async () => (ann = await connect(code, "ann")))).toEqual([CREW]);
    expect(presence("ann")).toEqual({ code, fighting: 0 });
    // Nothing the board shows changes with a walk.
    const to = ann.state.map.tiles.find((t) => t.biome === "plains" && !ann.state.units.some((u) => u.pos.q === t.q && u.pos.r === t.r))!;
    expect(await told(() => act(ann, { type: "move", unit: "ann", to: { q: to.q, r: to.r } }))).toEqual([]);
    ann.close();
    expect(await told(() => zone.webSocketClose(ann as unknown as WebSocket, 1000))).toEqual([CREW]);
    expect(presence("ann")).toBeUndefined();
  });

  it("tells the Harbor once when a fight starts and once when it ends, however many of the crew are in it", async () => {
    const code = await createZoneRow(db, "ann", zoneOptions({ size: "small", biome: "meadow", groups: 1, kinds: ["wolf"], elevation: 0, obstacles: 0, clear: 3, party: 3 }), "harbor-news");
    const ann = await connect(code, "ann");
    await connect(code, "bo");
    await connect(code, "cy");
    await act(ann, { type: "dev", dev: { op: "ai", off: true } });
    // The fight starts: all three are written down as fighting, and the board is read again once.
    expect(await told(() => act(ann, { type: "dev", dev: { op: "start_fight" } }))).toEqual([CREW]);
    expect(ann.state.encounter?.order).toEqual(expect.arrayContaining(["ann", "bo", "cy"]));
    expect(["ann", "bo", "cy"].map((id) => presence(id)?.fighting)).toEqual([1, 1, 1]);
    // It ends: each is paid and written down as out of it, and the board is read again once, after all of that.
    const levels = () => (sql.prepare("SELECT SUM(xp + level * 100000) AS n FROM characters").get() as { n: number }).n;
    const before = levels();
    expect(await told(() => act(ann, { type: "dev", dev: { op: "end_fight" } }))).toEqual([CREW]);
    expect(levels()).toBeGreaterThan(before);
    expect(["ann", "bo", "cy"].map((id) => presence(id)?.fighting)).toEqual([0, 0, 0]);
  });

  it("tells no Harbor of someone who is in no crew", async () => {
    const code = await createZoneRow(db, "dee", zoneOptions({ size: "small", biome: "meadow", groups: 1, kinds: ["wolf"], elevation: 0, obstacles: 0, clear: 3, party: 1 }), "harbor-news");
    expect(await told(() => connect(code, "dee"))).toEqual([]);
    expect(presence("dee")).toEqual({ code, fighting: 0 });
  });
});
