// The Harbor's "unstick" message: a stuck or lost hero is put back on the
// spawn hex. The room is driven with fake hibernatable sockets, whose
// attachments hold who each player is and where they stand.

import { beforeEach, describe, expect, it, vi } from "vitest";
import { HARBOR_SPAWN, UNSTICK_COOLDOWN_MS, type HarborPlayer, type HarborServerMessage } from "@gantt-quest/world";

(globalThis as Record<string, unknown>).WebSocketRequestResponsePair = class {
  constructor(
    public request: string,
    public response: string,
  ) {}
};

const { HarborRoom } = await import("../src/server/harbor-room");

class FakeSocket {
  sent: HarborServerMessage[] = [];
  constructor(private attachment: HarborPlayer | null) {}
  deserializeAttachment() {
    return this.attachment;
  }
  serializeAttachment(next: HarborPlayer | null) {
    this.attachment = next;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close() {}
}

const hero = (id: string, pos: { q: number; r: number }): HarborPlayer => ({ id, name: id, classId: "fighter", level: 1, pos });

describe("HarborRoom unstick", () => {
  let mine: FakeSocket;
  let theirs: FakeSocket;
  let room: InstanceType<typeof HarborRoom>;
  const away = { q: HARBOR_SPAWN.q + 3, r: HARBOR_SPAWN.r - 2 };
  const elsewhere = { q: HARBOR_SPAWN.q - 2, r: HARBOR_SPAWN.r + 1 };

  beforeEach(() => {
    vi.useRealTimers();
    mine = new FakeSocket({ ...hero("me", away), bedroll: away });
    theirs = new FakeSocket(hero("them", elsewhere));
    const sockets = [mine, theirs];
    const ctx = {
      setWebSocketAutoResponse() {},
      getWebSockets: (tag?: string) => (tag ? sockets.filter((s) => s.deserializeAttachment()?.id === tag) : sockets),
    };
    room = new HarborRoom(ctx as never, {} as never);
  });

  const unstick = (ws: FakeSocket, extra: Record<string, unknown> = {}) => room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "unstick", ...extra }));

  it("puts your own hero on the spawn hex and tells everyone", async () => {
    await unstick(mine);
    expect(mine.deserializeAttachment()?.pos).toEqual(HARBOR_SPAWN);
    // Lying down is over: the bedroll is rolled up.
    expect(mine.deserializeAttachment()?.bedroll).toBeUndefined();
    const news = { type: "placed", id: "me", pos: HARBOR_SPAWN };
    expect(mine.sent).toContainEqual(news);
    expect(theirs.sent).toContainEqual(news);
  });

  it("cannot move anyone else, even when asked to by id", async () => {
    await unstick(mine, { id: "them", player: "them" });
    expect(theirs.deserializeAttachment()?.pos).toEqual(elsewhere);
    expect(mine.deserializeAttachment()?.pos).toEqual(HARBOR_SPAWN);
    expect(theirs.sent.filter((m) => m.type === "placed").every((m) => m.type === "placed" && m.id === "me")).toBe(true);
  });

  it("is rate-limited per player", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000_000);
    await unstick(mine);
    // Walk off, then ask again straight away: refused.
    await room.webSocketMessage(mine as unknown as WebSocket, JSON.stringify({ type: "move", to: away }));
    const walked = mine.deserializeAttachment()?.pos;
    expect(walked).toEqual(away);
    await unstick(mine);
    expect(mine.deserializeAttachment()?.pos).toEqual(walked);
    // Another player is not held up by my limit.
    await unstick(theirs);
    expect(theirs.deserializeAttachment()?.pos).toEqual(HARBOR_SPAWN);
    // Once the cooldown has passed, it works again.
    vi.setSystemTime(1_000_000 + UNSTICK_COOLDOWN_MS + 1);
    await unstick(mine);
    expect(mine.deserializeAttachment()?.pos).toEqual(HARBOR_SPAWN);
    vi.useRealTimers();
  });
});
