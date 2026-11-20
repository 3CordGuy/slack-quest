// Walking about the Harbor when the client shows its own walks at the click: the room answers every walk
// asked for (the walk it made, or that it made none), and the client holds each answer against what it showed.

import { beforeEach, describe, expect, it } from "vitest";
import { HARBOR_SPAWN, generateHarbor, harborPath } from "@gantt-quest/world";
import { answeredWalk } from "../src/client/harborAhead";
import { HarborSocket } from "./rooms";

const { HarborRoom } = await import("../src/server/harbor-room");

const MAP = generateHarbor();
// Three hexes east along the High Street: always open ground.
const along = { q: HARBOR_SPAWN.q + 3, r: HARBOR_SPAWN.r };

describe("HarborRoom walks", () => {
  let mine: HarborSocket;
  let theirs: HarborSocket;
  let room: InstanceType<typeof HarborRoom>;
  const move = (ws: HarborSocket, to: unknown) => room.webSocketMessage(ws as unknown as WebSocket, JSON.stringify({ type: "move", to }));

  beforeEach(() => {
    mine = new HarborSocket({ id: "me", name: "me", classId: "fighter", level: 1, pos: HARBOR_SPAWN });
    theirs = new HarborSocket({ id: "them", name: "them", classId: "fighter", level: 1, pos: along });
    const sockets = [mine, theirs];
    const ctx = { setWebSocketAutoResponse() {}, getWebSockets: () => sockets };
    room = new HarborRoom(ctx as never, {} as never);
  });

  it("walks the way the client foresaw, and tells everyone", async () => {
    const shown = harborPath(MAP, HARBOR_SPAWN, along, null)!;
    await move(mine, along);
    expect(mine.sent).toEqual([{ type: "moved", id: "me", path: shown }]);
    expect(theirs.sent).toEqual(mine.sent);
    // And the next one sets off from where that one ended, as the client's next does.
    const next = harborPath(MAP, along, HARBOR_SPAWN, null)!;
    await move(mine, HARBOR_SPAWN);
    expect(mine.sent.at(-1)).toEqual({ type: "moved", id: "me", path: next });
  });

  it("tells the one who asked, and nobody else, when it makes no walk", async () => {
    // Onto the hex they stand on: no walk to make.
    await move(mine, HARBOR_SPAWN);
    expect(mine.sent).toEqual([{ type: "stayed", id: "me", pos: HARBOR_SPAWN }]);
    expect(theirs.sent).toEqual([]);
    expect(mine.deserializeAttachment()?.pos).toEqual(HARBOR_SPAWN);
    // Out to sea with no boat is no walk either.
    const sea = MAP.tiles.find((t) => t.biome === "water" && harborPath(MAP, HARBOR_SPAWN, t, null) === null)!;
    await move(mine, { q: sea.q, r: sea.r });
    expect(mine.sent.at(-1)).toEqual({ type: "stayed", id: "me", pos: HARBOR_SPAWN });
    // Something that is not a hex at all is still dropped unanswered.
    await move(mine, "the pub");
    expect(mine.sent).toHaveLength(2);
  });
});

describe("an answer held against what was shown", () => {
  const a = [{ q: 1, r: 0 }, { q: 2, r: 0 }];
  const b = [{ q: 3, r: 0 }];

  it("needs nothing more when it is what was shown, and leaves the rest standing", () => {
    expect(answeredWalk([a, b], a)).toEqual({ ahead: [b], shown: true });
    expect(answeredWalk([null, b], null)).toEqual({ ahead: [b], shown: true });
  });

  it("shows the room's walk, and forgets everything shown ahead, when it is another way", () => {
    expect(answeredWalk([a, b], [{ q: 1, r: 1 }, { q: 2, r: 0 }])).toEqual({ ahead: [], shown: false });
    expect(answeredWalk([a, b], [a[0]])).toEqual({ ahead: [], shown: false });
  });

  it("takes a walk back when the room made none of it, and shows one the client did not foresee", () => {
    expect(answeredWalk([a, b], null)).toEqual({ ahead: [], shown: false });
    expect(answeredWalk([null, b], a)).toEqual({ ahead: [], shown: false });
  });

  it("shows a walk it was not waiting on at all (asked for before this connection)", () => {
    expect(answeredWalk([], a)).toEqual({ ahead: [], shown: false });
    expect(answeredWalk([], null)).toEqual({ ahead: [], shown: false });
  });
});
