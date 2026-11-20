// Emotes in the walk-in rooms (walk-room.ts, here through the Harbor's room):
// a wave, a cheer, a bow or a dance is shown to everyone there, the one
// emoting too, rate-limited and never kept.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { EMOTE_MIN_MS, HARBOR_SPAWN, type HarborPlayer } from "@gantt-quest/world";
import { HarborSocket } from "./rooms";

const { HarborRoom } = await import("../src/server/harbor-room");

const hero = (id: string): HarborPlayer => ({ id, name: id, classId: "fighter", level: 1, pos: HARBOR_SPAWN });

describe("HarborRoom emote", () => {
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

  const emote = (ws: HarborSocket, value: unknown, extra: Record<string, unknown> = {}) => room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "emote", emote: value, ...extra }));
  const emotes = (ws: HarborSocket) => ws.sent.filter((m) => m.type === "emoted");

  it("shows everyone, you too, and always as the sender's own hero", async () => {
    await emote(mine, "wave", { id: "them" });
    expect(emotes(theirs)).toEqual([{ type: "emoted", id: "me", emote: "wave" }]);
    expect(emotes(mine)).toEqual([{ type: "emoted", id: "me", emote: "wave" }]);
  });

  it("drops what is not an emote", async () => {
    for (const bad of ["moonwalk", null, 3, ["wave"]]) await emote(mine, bad);
    expect(emotes(theirs)).toEqual([]);
  });

  it("passes on no more than one per EMOTE_MIN_MS from each player, and keeps nothing", async () => {
    const before = JSON.stringify(mine.deserializeAttachment());
    await emote(mine, "cheer");
    vi.advanceTimersByTime(EMOTE_MIN_MS - 1);
    await emote(mine, "bow");
    await emote(theirs, "dance");
    vi.advanceTimersByTime(1);
    await emote(mine, "bow");
    expect(emotes(mine).map((m) => m.type === "emoted" && `${m.id}:${m.emote}`)).toEqual(["me:cheer", "them:dance", "me:bow"]);
    expect(JSON.stringify(mine.deserializeAttachment())).toBe(before);
  });
});
