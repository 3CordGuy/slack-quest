// The connection every room's hook is built on (client/useRoom.ts, openRoomSocket), with a stand-in WebSocket
// and the clock in hand: where it connects, the pause before each new try and when it gives up, what it says
// when the place is open in another tab or would not open at all, the ping, and that nothing more happens
// once it is closed. These are the ways the Harbor's, a hut's, the pub's and a map's connections behaved
// when each had its own copy, and the ways they differed.

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { RoomSocketSpec } from "../src/client/useRoom";

const PAGE = { protocol: "https:", host: "harbor.test", search: "" };
let openRoomSocket: typeof import("../src/client/useRoom").openRoomSocket;
let gaze: typeof import("../src/client/gaze").gaze;
// The client reads the page's address as it loads, so there has to be one first.
beforeAll(async () => {
  vi.stubGlobal("location", PAGE);
  ({ openRoomSocket } = await import("../src/client/useRoom"));
  ({ gaze } = await import("../src/client/gaze"));
}, 60_000);

/** A WebSocket that goes nowhere: the test opens it, closes it and speaks for the room. */
class FakeSocket {
  static OPEN = 1;
  static made: FakeSocket[] = [];
  readyState = 0;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((e: { data: string }) => void) | null = null;
  onclose: ((e: { code: number }) => void | Promise<void>) | null = null;
  constructor(public url: string) {
    FakeSocket.made.push(this);
  }
  send(data: string) {
    this.sent.push(data);
  }
  /** Closed from this end: a browser tells the page afterwards. */
  close() {
    this.readyState = 3;
  }
  open() {
    this.readyState = 1;
    this.onopen?.();
  }
  /** The other end, or the network, closed it. */
  drop(code = 1006) {
    this.readyState = 3;
    return this.onclose?.({ code });
  }
  say(msg: unknown) {
    this.onmessage?.({ data: typeof msg === "string" ? msg : JSON.stringify(msg) });
  }
}

const last = () => FakeSocket.made[FakeSocket.made.length - 1];
let fetched: string[] = [];
let answer: { status: number; text: string } | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  FakeSocket.made = [];
  fetched = [];
  answer = null;
  vi.stubGlobal("location", PAGE);
  vi.stubGlobal("WebSocket", FakeSocket);
  vi.stubGlobal("fetch", async (url: string) => {
    fetched.push(url);
    if (!answer) throw new Error("no network");
    return { status: answer.status, text: async () => answer!.text };
  });
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** Open a connection the way a room's hook does, and keep what it is told. */
function open(spec: Partial<RoomSocketSpec<{ type: string }>> = {}) {
  const statuses: string[] = [];
  const errors: (string | null)[] = [];
  const heard: unknown[] = [];
  const whole: RoomSocketSpec<{ type: string }> = { path: () => "/api/room/ws", onMessage: (msg) => void heard.push(msg), elsewhere: "Open in another tab.", ...spec };
  const socket = openRoomSocket(() => whole, { status: (s) => void statuses.push(s), error: (e) => void errors.push(e) });
  return { socket, statuses, errors, heard };
}

describe("a room's connection", () => {
  it("opens at the address it is given, over wss on an https page, and says how it stands", async () => {
    const { statuses, errors } = open();
    expect(last().url).toBe("wss://harbor.test/api/room/ws");
    expect(statuses).toEqual(["connecting"]);
    last().open();
    expect(statuses).toEqual(["connecting", "open"]);
    // Opening clears whatever error was up.
    expect(errors).toEqual([null]);
  });

  it("hands on every message but the pong, with the connection it came on", async () => {
    const seen: unknown[] = [];
    open({ onMessage: (msg, ws) => void seen.push([msg, ws]) });
    last().open();
    last().say("pong");
    last().say({ type: "snapshot" });
    expect(seen).toEqual([[{ type: "snapshot" }, last()]]);
  });

  it("sends only while open, and says whether it did", async () => {
    const { socket } = open();
    expect(socket.send({ type: "move" })).toBe(false);
    last().open();
    expect(socket.send({ type: "move" })).toBe(true);
    expect(last().sent).toEqual(['{"type":"move"}']);
    last().drop();
    expect(socket.send({ type: "move" })).toBe(false);
  });

  it("tries again after 1, 2, 4, 8, 8 and 8 seconds, then gives up and says so", async () => {
    const { statuses, errors } = open({ lost: "Lost the connection." });
    last().open();
    const pauses: number[] = [];
    for (let i = 0; i < 6; i++) {
      const before = FakeSocket.made.length;
      await last().drop();
      let waited = 0;
      while (FakeSocket.made.length === before && waited < 60_000) {
        vi.advanceTimersByTime(500);
        waited += 500;
      }
      pauses.push(waited);
    }
    expect(pauses).toEqual([1000, 2000, 4000, 8000, 8000, 8000]);
    // The seventh drop in a row is the end of it.
    await last().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made.length).toBe(7);
    expect(errors[errors.length - 1]).toBe("Lost the connection.");
    expect(statuses[statuses.length - 1]).toBe("closed");
  });

  it("starts the count of tries again once a connection opens", async () => {
    open({ lost: "Lost the connection." });
    last().open();
    for (let i = 0; i < 3; i++) {
      await last().drop();
      vi.advanceTimersByTime(8000);
    }
    last().open();
    const before = FakeSocket.made.length;
    await last().drop();
    vi.advanceTimersByTime(999);
    expect(FakeSocket.made.length).toBe(before);
    vi.advanceTimersByTime(1);
    expect(FakeSocket.made.length).toBe(before + 1);
  });

  it("gives up without a word where it has none to say (a map)", async () => {
    const { errors } = open();
    last().open();
    for (let i = 0; i < 7; i++) {
      await last().drop();
      vi.advanceTimersByTime(8000);
    }
    expect(FakeSocket.made.length).toBe(7);
    expect(errors).toEqual([null]);
  });

  it("asks for the address again at every connection", async () => {
    let n = 0;
    open({ path: () => `/api/room/ws?at=${++n}` });
    last().open();
    await last().drop();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made.map((s) => s.url)).toEqual(["wss://harbor.test/api/room/ws?at=1", "wss://harbor.test/api/room/ws?at=2"]);
  });

  it("does not try again when the place was opened in another tab", async () => {
    const { errors } = open({ lost: "Lost the connection." });
    last().open();
    await last().drop(4000);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made.length).toBe(1);
    expect(errors[errors.length - 1]).toBe("Open in another tab.");
  });

  it("tries again when it never opened, where nothing else is asked for (the Harbor)", async () => {
    const { errors } = open();
    await last().drop();
    expect(fetched).toEqual([]);
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made.length).toBe(2);
    expect(errors).toEqual([]);
  });

  it("asks why it was turned away, and shows a refusal instead of trying again (a hut, the pub)", async () => {
    answer = { status: 403, text: "This hut is not yours to enter." };
    const { errors } = open({ unopened: "ask" });
    await last().drop();
    expect(fetched).toEqual(["/api/room/ws"]);
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made.length).toBe(1);
    expect(errors).toEqual(["This hut is not yours to enter."]);
  });

  it("tries again when asking why gets no refusal, and stops asking once it has been open", async () => {
    answer = { status: 500, text: "oops" };
    const { errors } = open({ unopened: "ask" });
    await last().drop();
    vi.advanceTimersByTime(1000);
    expect(FakeSocket.made.length).toBe(2);
    // No network at all is no refusal either.
    answer = null;
    await last().drop();
    vi.advanceTimersByTime(2000);
    expect(FakeSocket.made.length).toBe(3);
    expect(fetched.length).toBe(2);
    last().open();
    await last().drop();
    expect(fetched.length).toBe(2);
    expect(errors).toEqual([null]);
  });

  it("says what it is given and stops when it never opened (a map)", async () => {
    const { errors } = open({ unopened: { error: "Could not reach that map." } });
    await last().drop();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made.length).toBe(1);
    expect(errors).toEqual(["Could not reach that map."]);
    expect(fetched).toEqual([]);
  });

  it("leaves an error up on opening where the view clears it (a map), and tells of each opening", async () => {
    let opened = 0;
    const { errors } = open({ keepError: true, onOpen: () => void opened++ });
    last().open();
    await last().drop();
    vi.advanceTimersByTime(1000);
    last().open();
    expect(errors).toEqual([]);
    expect(opened).toBe(2);
  });

  it("pings every 25 seconds while open", async () => {
    open();
    vi.advanceTimersByTime(25_000);
    expect(last().sent).toEqual([]);
    last().open();
    vi.advanceTimersByTime(50_000);
    expect(last().sent).toEqual(["ping", "ping"]);
  });

  it("sends which way your hero looks, where asked to, until it is closed", async () => {
    const quiet = open();
    last().open();
    const mute = last();
    gaze.look(3);
    expect(mute.sent).toEqual([]);
    quiet.socket.close();

    const { socket } = open({ looks: true });
    const ws = last();
    gaze.look(4);
    ws.open();
    gaze.look(5);
    expect(ws.sent).toEqual(['{"type":"look","look":5}']);
    socket.close();
    gaze.look(6);
    expect(ws.sent).toEqual(['{"type":"look","look":5}']);
  });

  it("does nothing more once closed: no word of the close, no new try, no ping", async () => {
    const { socket, statuses, errors } = open({ lost: "Lost the connection." });
    last().open();
    await last().drop();
    socket.close();
    vi.advanceTimersByTime(60_000);
    expect(FakeSocket.made.length).toBe(1);

    const again = open({ lost: "Lost the connection." });
    const ws = last();
    ws.open();
    again.socket.close();
    expect(ws.readyState).toBe(3);
    await ws.onclose?.({ code: 1000 });
    vi.advanceTimersByTime(60_000);
    expect(again.statuses).toEqual(["connecting", "open"]);
    expect(ws.sent).toEqual([]);
    expect(FakeSocket.made.length).toBe(2);
    expect(statuses[statuses.length - 1]).toBe("closed");
    expect(errors).toEqual([null]);
  });

  it("drops the answer to why it was turned away if it was closed meanwhile", async () => {
    answer = { status: 403, text: "Not yours." };
    const { socket, errors } = open({ unopened: "ask" });
    const asked = last().drop();
    socket.close();
    await asked;
    expect(errors).toEqual([]);
  });
});
