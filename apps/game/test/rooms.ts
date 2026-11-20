// Stand-ins for the parts of the Workers runtime a room's tests touch: a
// hibernatable socket, and the globals Node does not have. (The Durable
// Object base class is in cloudflareWorkers.ts.) Not a test file itself.
//
// Importing this is enough for a room to be made: its constructor sets a
// ping/pong auto-response, which needs WebSocketRequestResponsePair to exist.

import type { HarborPlayer, HarborServerMessage } from "@gantt-quest/world";

const globals = globalThis as Record<string, unknown>;

globals.WebSocketRequestResponsePair = class {
  constructor(
    public request: string,
    public response: string,
  ) {}
};

/** One socket as a room holds it: what is attached to it, everything sent down it, and whether it was closed. */
export class FakeSocket<Message = unknown, Attachment = unknown> {
  sent: Message[] = [];
  closed: number | null = null;
  tags: string[] = [];
  constructor(private attachment: Attachment | null = null) {}
  deserializeAttachment() {
    return this.attachment;
  }
  serializeAttachment(next: Attachment | null) {
    this.attachment = next;
  }
  send(data: string) {
    this.sent.push(JSON.parse(data));
  }
  close(code = 1000) {
    this.closed = code;
  }
}

/** A socket in a crew's Harbor: what is attached is who its player is and where they stand. */
export class HarborSocket extends FakeSocket<HarborServerMessage, HarborPlayer> {}

/**
 * What the runtime keeps for a room, for a test that walks people in through its `fetch`: the sockets it has
 * accepted (found by their tags; one that has been closed is no longer handed back) and its storage. They are kept
 * outside the room, as the runtime keeps them, so a second room made on the same `ctx` is the first one woken from
 * hibernation. `ready` is whatever the room's constructor asked to be waited for before anything else reaches it.
 */
export function fakeRoomState<Socket extends FakeSocket = FakeSocket>() {
  const state = {
    sockets: [] as Socket[],
    storage: new Map<string, unknown>(),
    ready: Promise.resolve() as Promise<unknown>,
    ctx: {
      setWebSocketAutoResponse() {},
      waitUntil() {},
      blockConcurrencyWhile: (fn: () => Promise<unknown>) => (state.ready = fn()),
      getWebSockets: (tag?: string) => state.sockets.filter((s) => s.closed === null && (!tag || s.tags.includes(tag))),
      getTags: (ws: Socket) => ws.tags,
      acceptWebSocket(ws: Socket, tags: string[] = []) {
        ws.tags = tags;
        state.sockets.push(ws);
      },
      storage: {
        get: async (key: string) => state.storage.get(key),
        put: async (key: string, value: unknown) => void state.storage.set(key, value),
        delete: async (key: string) => state.storage.delete(key),
      },
    },
  };
  return state;
}

/**
 * For a test that walks someone in through a room's `fetch`: the room makes a WebSocketPair and answers 101,
 * neither of which Node can do. After this, the server's end of the next pair is whatever socket was last handed
 * to the function returned (the client's end is never looked at), and a 101 answer is a bare `{ status: 101 }`.
 */
export function fakeUpgrades(): (server: object) => void {
  let next: object | undefined;
  globals.WebSocketPair = class {
    0 = {};
    1 = next;
  };
  const RealResponse = Response;
  globals.Response = Object.assign(
    function (body: unknown, init?: { status?: number; webSocket?: unknown }) {
      return init?.status === 101 ? { status: 101 } : new RealResponse(body as BodyInit, init as ResponseInit);
    },
    { json: (data: unknown, init?: ResponseInit) => RealResponse.json(data, init) },
  ) as unknown as typeof Response;
  return (server) => {
    next = server;
  };
}
