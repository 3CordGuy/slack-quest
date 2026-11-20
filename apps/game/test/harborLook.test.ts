// The Harbor's "look" message: which way a hero is facing as they stand
// (toward their player's pointer) is passed on to everyone else there, so
// teammates see it too. It is only for show: coarse, rate-limited, and never
// kept. The room is driven with fake hibernatable sockets (rooms.ts).

import { beforeEach, describe, expect, it, vi } from "vitest";
import { HARBOR_SPAWN, LOOK_MIN_MS, LOOK_STEPS, lookStep, lookYaw, validLook, type HarborPlayer } from "@gantt-quest/world";
import { HarborSocket } from "./rooms";

const { HarborRoom } = await import("../src/server/harbor-room");

const hero = (id: string): HarborPlayer => ({ id, name: id, classId: "fighter", level: 1, pos: HARBOR_SPAWN });

describe("looking", () => {
  it("turns a facing into one of the compass steps and back", () => {
    expect(lookStep(0)).toBe(0);
    expect(lookStep(Math.PI / 2)).toBe(LOOK_STEPS / 4);
    // Turns come out of atan2 from -pi to pi, and wrap.
    expect(lookStep(-Math.PI / 2)).toBe((LOOK_STEPS * 3) / 4);
    expect(lookStep(Math.PI * 2)).toBe(0);
    expect(lookStep(-0.01)).toBe(0);
    for (let step = 0; step < LOOK_STEPS; step++) expect(lookStep(lookYaw(step))).toBe(step);
  });

  it("takes only a whole step in range from a client", () => {
    expect(validLook(0)).toBe(0);
    expect(validLook(LOOK_STEPS - 1)).toBe(LOOK_STEPS - 1);
    for (const bad of [LOOK_STEPS, -1, 1.5, "3", null, undefined, NaN, Infinity, {}]) expect(validLook(bad)).toBeNull();
  });
});

describe("HarborRoom look", () => {
  let mine: HarborSocket;
  let theirs: HarborSocket;
  let room: InstanceType<typeof HarborRoom>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    mine = new HarborSocket(hero("me"));
    theirs = new HarborSocket(hero("them"));
    const sockets = [mine, theirs];
    const ctx = {
      setWebSocketAutoResponse() {},
      getWebSockets: (tag?: string) => (tag ? sockets.filter((s) => s.deserializeAttachment()?.id === tag) : sockets),
    };
    room = new HarborRoom(ctx as never, {} as never);
  });

  const look = (ws: HarborSocket, value: unknown, extra: Record<string, unknown> = {}) => room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "look", look: value, ...extra }));
  const looks = (ws: HarborSocket) => ws.sent.filter((m) => m.type === "looked");

  it("tells everyone else which way you look, and not you", async () => {
    await look(mine, 5);
    expect(looks(theirs)).toEqual([{ type: "looked", id: "me", look: 5 }]);
    expect(looks(mine)).toEqual([]);
  });

  it("is always the sender's own hero, whatever id is sent with it", async () => {
    await look(mine, 7, { id: "them", player: "them" });
    expect(looks(theirs)).toEqual([{ type: "looked", id: "me", look: 7 }]);
  });

  it("drops anything that is not a step round the compass", async () => {
    for (const bad of [LOOK_STEPS, -1, 2.5, "4", null]) await look(mine, bad);
    expect(looks(theirs)).toEqual([]);
  });

  it("passes on no more than one look per LOOK_MIN_MS from each player", async () => {
    await look(mine, 1);
    vi.advanceTimersByTime(LOOK_MIN_MS - 1);
    await look(mine, 2);
    expect(looks(theirs).map((m) => m.type === "looked" && m.look)).toEqual([1]);
    vi.advanceTimersByTime(1);
    await look(mine, 3);
    expect(looks(theirs).map((m) => m.type === "looked" && m.look)).toEqual([1, 3]);
    // Someone else's looks are counted on their own.
    await look(theirs, 9);
    expect(looks(mine)).toEqual([{ type: "looked", id: "them", look: 9 }]);
  });

  it("does not move anyone or change what is kept about them", async () => {
    const before = JSON.stringify(mine.deserializeAttachment());
    await look(mine, 4);
    expect(JSON.stringify(mine.deserializeAttachment())).toBe(before);
  });
});
