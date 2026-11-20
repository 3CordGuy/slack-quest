// WebSocket connection to the crew's HarborRoom: who is here, where they
// stand, and what is on the notice board. It is closed while the player is
// away (see awake.ts) and opened again when they come back, standing where
// they stood.
//
// Your own walk is shown at the click, not when the room answers: the way
// there is found with the same harborPath the room uses, from where your
// hero is believed to stand, so the two agree. The room's own word still
// decides. It answers every walk asked for, in the order asked: with the
// walk it made ("moved") or by saying it made none ("stayed"). An answer
// that is what was shown needs nothing more; one that is not (another way,
// or no walk where one was shown) is shown as the room has it, and
// everything shown ahead of it is forgotten.
//
// The connection itself, and what every walk-in place's room says the same
// way (who left, XP, looks, the chat), is useRoom.ts.

import { useCallback, useEffect, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { HARBOR_NAME, generateHarbor, harborPath, type HarborBoard, type HarborClientMessage, type HarborPlayer, type HarborServerMessage, type Muster, type XpMessage } from "@gantt-quest/world";
import { PROFILE } from "./api";
import { useAwake } from "./awake";
import { answeredWalk } from "./harborAhead";
import { useRoomPeople, useRoomSocket, type ChatLine } from "./useRoom";

export interface HarborConnection {
  you: string | null;
  crew: { id: string; name: string } | null;
  players: HarborPlayer[];
  board: HarborBoard;
  chat: ChatLine[];
  /** "paused": closed while the player is away; it opens again when they are back. */
  status: "connecting" | "open" | "closed" | "paused";
  error: string | null;
  /** Counts up whenever the player's trades may have changed (a crewmate changed one, or the connection is new): ask for them again. */
  trades: number;
  /** The crew's muster as the room last told it (someone setting out for a place on the atlas, asking who is coming), or null. */
  muster: Muster | null;
  send(message: HarborClientMessage): void;
}

const EMPTY: HarborBoard = { members: [] };

/** The Harbor's map, made once: the same one the room walks on. */
let harborMap: ReturnType<typeof generateHarbor> | null = null;
const theHarbor = () => (harborMap ??= generateHarbor());

/**
 * `onMoved` fires for every walk, including your own, so the renderer can animate it; `onSaid` for every chat line, yours too, so it can show it over the speaker.
 * `here`: false while the player is inside one of the Harbor's buildings with the Harbor kept behind it (HarborView's
 * `resting`). The connection is closed, as when they are away, so nobody sees them standing outside; it opens again
 * as they step back out, at the door they went in by.
 */
export function useHarbor(onMoved: (id: string, path: HexPos[]) => void, onXp?: (m: XpMessage) => void, onSaid?: (id: string, text: string) => void, here = true): HarborConnection {
  const [crew, setCrew] = useState<HarborConnection["crew"]>(null);
  const [board, setBoard] = useState<HarborBoard>(EMPTY);
  const [trades, setTrades] = useState(0);
  const [muster, setMuster] = useState<Muster | null>(null);
  const awake = useAwake();
  const people = useRoomPeople(onMoved, onXp, onSaid);
  const { you, players, chat, setPlayers, walked } = people;
  /** Where your own hero stands, to ask for again after a pause. */
  const standing = useRef<HexPos | null>(null);
  standing.current = (you && players.find((p) => p.id === you)?.pos) || null;
  /** What was shown for each of your own walks not yet answered by the room, oldest first (null: nothing), and where the last of them leaves your hero. */
  const ahead = useRef<(HexPos[] | null)[]>([]);
  const believed = useRef<{ id: string; pos: HexPos; vessel: HarborPlayer["vessel"] } | null>(null);
  /**
   * Walks asked for while the connection was still opening (stepping out of a building, coming home from a map:
   * the Harbor is on the screen at once, a moment before its room answers). They are shown at the click, from
   * where your hero stands, and sent when the room is there.
   */
  const waiting = useRef<HarborClientMessage[]>([]);
  const post = useRef<(message: unknown) => boolean>(() => false);
  /** The connection is on its way up. (Lost for good, or the player away, nothing is kept to send.) */
  const opening = useRef(false);
  /** A walk, as it is shown: the walker is at its end, and the renderer plays the way there. */
  const showWalk = (id: string, path: HexPos[]) => {
    const end = path[path.length - 1];
    // Walking off rolls their bedroll back up.
    setPlayers((ps) => ps.map((p) => (p.id === id ? { ...p, pos: end, bedroll: undefined, fishing: undefined } : p)));
    walked(id, path);
  };

  const socket = useRoomSocket<HarborServerMessage>({
    awake: awake && here,
    looks: true,
    elsewhere: `${HARBOR_NAME} is open in another tab.`,
    lost: "Lost the connection to the Harbor. Reload to try again.",
    path() {
      // Coming out of a hut: ask to arrive at its door rather than the usual spot.
      const query = new URLSearchParams(PROFILE ? { p: PROFILE } : {});
      try {
        const at = sessionStorage.getItem("gq.harborAt");
        if (at) query.set("at", at);
      } catch {
        // No hint; the Harbor picks.
      }
      // Back after a pause or a dropped connection: stand where you stood.
      if (!query.has("at") && standing.current) query.set("at", `${standing.current.q},${standing.current.r}`);
      return `/api/crew/ws${query.size ? `?${query}` : ""}`;
    },
    onMessage(msg) {
      if (msg.type === "snapshot") {
        // The hint has been used. (Cleared here, not on connect, so a connection dropped before it lands can ask again.)
        try {
          sessionStorage.removeItem("gq.harborAt");
        } catch {
          // Nothing to clear.
        }
        const me = msg.players.find((p) => p.id === msg.you);
        const asked = waiting.current;
        waiting.current = [];
        if (asked.length > 0 && me && believed.current?.id === me.id) {
          // Walks were shown while this connection opened: you are left where they have taken you, and the room
          // is asked for them now. Its answers are checked against what was shown, as ever.
          const at = believed.current.pos;
          people.hear({ ...msg, players: msg.players.map((p) => (p.id === me.id ? { ...p, pos: at, bedroll: undefined, fishing: undefined } : p)) });
          believed.current = { ...believed.current, vessel: me.vessel };
          for (const m of asked) post.current(m);
        } else {
          people.hear(msg);
          // A new connection: whatever was shown ahead on the old one is gone, and this is where you stand.
          ahead.current = [];
          believed.current = me ? { id: me.id, pos: me.pos, vessel: me.vessel } : null;
        }
        setCrew(msg.crew);
        setBoard({ members: msg.members, works: msg.works, maps: msg.maps });
        // A trade may have changed while there was no connection to hear of it.
        setTrades((n) => n + 1);
      } else if (msg.type === "trades") {
        setTrades((n) => n + 1);
      } else if (msg.type === "muster") {
        setMuster(msg.muster);
      } else if (msg.type === "board") {
        setBoard({ members: msg.members, works: msg.works, maps: msg.maps });
      } else if (msg.type === "joined") {
        // Your own hero as the room has them now: a boat bought since changes where you can go. Where you stand
        // is kept as believed while walks are still ahead (the room tells this from where it last had you).
        const mine = believed.current?.id === msg.player.id;
        if (mine) believed.current = { id: msg.player.id, pos: ahead.current.length > 0 ? believed.current!.pos : msg.player.pos, vessel: msg.player.vessel };
        const held = mine && ahead.current.length > 0 ? believed.current!.pos : null;
        setPlayers((ps) => [...ps.filter((p) => p.id !== msg.player.id), held ? { ...msg.player, pos: held, bedroll: undefined, fishing: undefined } : msg.player]);
      } else if (msg.type === "placed") {
        // Put straight there (a stuck hero sent back): an empty walk stops any walk under way, and the unit slides over.
        if (believed.current?.id === msg.id) {
          ahead.current = [];
          believed.current = { ...believed.current, pos: msg.pos };
        }
        setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, pos: msg.pos, bedroll: undefined } : p)));
        walked(msg.id, []);
      } else if (msg.type === "stayed") {
        // The room made no walk of one you asked for. If none was shown either, the picture is right as it is.
        if (believed.current?.id !== msg.id) return;
        const told = answeredWalk(ahead.current, null);
        ahead.current = told.ahead;
        if (told.shown) return;
        // A walk was shown that did not happen: back to where the room has you.
        believed.current = { ...believed.current, pos: msg.pos };
        setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, pos: msg.pos } : p)));
        walked(msg.id, []);
      } else if (msg.type === "moved") {
        if (believed.current?.id === msg.id) {
          // Your own walk: most likely the one already shown at the click, and then there is nothing to do.
          const told = answeredWalk(ahead.current, msg.path);
          ahead.current = told.ahead;
          if (told.shown) return;
          // The room walked you another way: its word stands, from here on.
          believed.current = { ...believed.current, pos: msg.path[msg.path.length - 1] };
        }
        showWalk(msg.id, msg.path);
      } else {
        // Who left, XP, looks and the chat are as in every walk-in place.
        people.hear(msg);
      }
    },
  });

  post.current = socket.send;
  // Put away, nothing is waiting to be sent and nothing is shown ahead.
  useEffect(() => {
    if (here) return;
    waiting.current = [];
    ahead.current = [];
  }, [here]);
  const send = useCallback((message: HarborClientMessage) => {
    if (!post.current(message)) {
      // Not connected yet. A walk is kept for when it is, and shown now; anything else is let go, as before.
      if (message.type !== "move" || !believed.current || !opening.current) return;
      waiting.current.push(message);
    }
    // A walk is shown now, along the way the room will find from where your hero is believed to stand.
    const me = believed.current;
    if (message.type !== "move" || !me) return;
    const to = { q: Number(message.to?.q), r: Number(message.to?.r) };
    if (!Number.isInteger(to.q) || !Number.isInteger(to.r)) return;
    const path = harborPath(theHarbor(), me.pos, to, me.vessel ?? null);
    ahead.current.push(path);
    if (!path) return;
    believed.current = { ...me, pos: path[path.length - 1] };
    showWalk(me.id, path);
  }, []);
  opening.current = here && awake && socket.status === "connecting";
  return { you, crew, players, board, chat, status: socket.status, error: socket.error, trades, muster, send };
}
