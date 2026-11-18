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

import { useCallback, useEffect, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { HARBOR_NAME, generateHarbor, harborPath, type HarborBoard, type HarborClientMessage, type HarborPlayer, type HarborServerMessage, type XpMessage } from "@gantt-quest/world";
import { PROFILE } from "./api";
import { useAwake } from "./awake";
import { gaze } from "./gaze";
import { answeredWalk } from "./harborAhead";

export interface HarborChatLine {
  name: string;
  text: string;
}

export interface HarborConnection {
  you: string | null;
  crew: { id: string; name: string } | null;
  players: HarborPlayer[];
  board: HarborBoard;
  chat: HarborChatLine[];
  /** "paused": closed while the player is away; it opens again when they are back. */
  status: "connecting" | "open" | "closed" | "paused";
  error: string | null;
  /** Counts up whenever the player's trades may have changed (a crewmate changed one, or the connection is new): ask for them again. */
  trades: number;
  send(message: HarborClientMessage): void;
}

const EMPTY: HarborBoard = { members: [], ships: [], log: [] };

/** The Harbor's map, made once: the same one the room walks on. */
let harborMap: ReturnType<typeof generateHarbor> | null = null;
const theHarbor = () => (harborMap ??= generateHarbor());

/** `onMoved` fires for every walk, including your own, so the renderer can animate it; `onSaid` for every chat line, yours too, so it can show it over the speaker. */
export function useHarbor(onMoved: (id: string, path: HexPos[]) => void, onXp?: (m: XpMessage) => void, onSaid?: (id: string, text: string) => void): HarborConnection {
  const [you, setYou] = useState<string | null>(null);
  const [crew, setCrew] = useState<HarborConnection["crew"]>(null);
  const [players, setPlayers] = useState<HarborPlayer[]>([]);
  const [board, setBoard] = useState<HarborBoard>(EMPTY);
  const [chat, setChat] = useState<HarborChatLine[]>([]);
  const [status, setStatus] = useState<HarborConnection["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [trades, setTrades] = useState(0);
  const awake = useAwake();
  const socket = useRef<WebSocket | null>(null);
  /** Where your own hero stands, to ask for again after a pause. */
  const standing = useRef<HexPos | null>(null);
  standing.current = (you && players.find((p) => p.id === you)?.pos) || null;
  const moved = useRef(onMoved);
  moved.current = onMoved;
  const xpSeen = useRef(onXp);
  xpSeen.current = onXp;
  const said = useRef(onSaid);
  said.current = onSaid;
  /** What was shown for each of your own walks not yet answered by the room, oldest first (null: nothing), and where the last of them leaves your hero. */
  const ahead = useRef<(HexPos[] | null)[]>([]);
  const believed = useRef<{ id: string; pos: HexPos; vessel: HarborPlayer["vessel"] } | null>(null);
  /** A walk, as it is shown: the walker is at its end, and the renderer plays the way there. */
  const showWalk = (id: string, path: HexPos[]) => {
    const end = path[path.length - 1];
    // Walking off rolls their bedroll back up.
    setPlayers((ps) => ps.map((p) => (p.id === id ? { ...p, pos: end, bedroll: undefined, fishing: undefined } : p)));
    // After React has applied the new position, so the walk is not snapped over.
    queueMicrotask(() => moved.current(id, path));
  };

  useEffect(() => {
    if (!awake) {
      setStatus("paused");
      return;
    }
    let closed = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
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
      const ws = new WebSocket(`${proto}//${location.host}/api/crew/ws${query.size ? `?${query}` : ""}`);
      socket.current = ws;
      setStatus("connecting");
      ws.onopen = () => {
        attempts = 0;
        setStatus("open");
        setError(null);
      };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        const msg = JSON.parse(e.data) as HarborServerMessage;
        if (msg.type === "snapshot") {
          // The hint has been used. (Cleared here, not on connect, so a connection dropped before it lands can ask again.)
          try {
            sessionStorage.removeItem("gq.harborAt");
          } catch {
            // Nothing to clear.
          }
          setYou(msg.you);
          setCrew(msg.crew);
          setPlayers(msg.players);
          // A new connection: whatever was shown ahead on the old one is gone, and this is where you stand.
          ahead.current = [];
          const me = msg.players.find((p) => p.id === msg.you);
          believed.current = me ? { id: me.id, pos: me.pos, vessel: me.vessel } : null;
          setBoard({ members: msg.members, ships: msg.ships, log: msg.log, works: msg.works });
          // A trade may have changed while there was no connection to hear of it.
          setTrades((n) => n + 1);
        } else if (msg.type === "trades") {
          setTrades((n) => n + 1);
        } else if (msg.type === "board") {
          setBoard({ members: msg.members, ships: msg.ships, log: msg.log, works: msg.works });
        } else if (msg.type === "joined") {
          // Your own hero as the room has them now: a boat bought since changes where you can go. Where you stand
          // is kept as believed while walks are still ahead (the room tells this from where it last had you).
          const mine = believed.current?.id === msg.player.id;
          if (mine) believed.current = { id: msg.player.id, pos: ahead.current.length > 0 ? believed.current!.pos : msg.player.pos, vessel: msg.player.vessel };
          const held = mine && ahead.current.length > 0 ? believed.current!.pos : null;
          setPlayers((ps) => [...ps.filter((p) => p.id !== msg.player.id), held ? { ...msg.player, pos: held, bedroll: undefined, fishing: undefined } : msg.player]);
        } else if (msg.type === "left") {
          setPlayers((ps) => ps.filter((p) => p.id !== msg.id));
        } else if (msg.type === "placed") {
          // Put straight there (a stuck hero sent back): an empty walk stops any walk under way, and the unit slides over.
          if (believed.current?.id === msg.id) {
            ahead.current = [];
            believed.current = { ...believed.current, pos: msg.pos };
          }
          setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, pos: msg.pos, bedroll: undefined } : p)));
          queueMicrotask(() => moved.current(msg.id, []));
        } else if (msg.type === "stayed") {
          // The room made no walk of one you asked for. If none was shown either, the picture is right as it is.
          if (believed.current?.id !== msg.id) return;
          const told = answeredWalk(ahead.current, null);
          ahead.current = told.ahead;
          if (told.shown) return;
          // A walk was shown that did not happen: back to where the room has you.
          believed.current = { ...believed.current, pos: msg.pos };
          setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, pos: msg.pos } : p)));
          queueMicrotask(() => moved.current(msg.id, []));
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
        } else if (msg.type === "xp") {
          // Someone here earned XP: their plate shows the new level and bar, then the sparkle plays.
          setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, level: msg.level, xp: msg.xp } : p)));
          queueMicrotask(() => xpSeen.current?.(msg));
        } else if (msg.type === "looked") {
          gaze.looked(msg.id, msg.look);
        } else if (msg.type === "said") {
          setChat((c) => [...c, { name: msg.name, text: msg.text }].slice(-30));
          // Over their head too, for everyone who can see them.
          said.current?.(msg.id, msg.text);
        }
      };
      ws.onclose = (e) => {
        if (closed) return;
        setStatus("closed");
        if (e.code === 4000) return setError(`${HARBOR_NAME} is open in another tab.`);
        if (attempts++ < 6) retry = setTimeout(connect, Math.min(8000, 500 * 2 ** attempts));
        else setError("Lost the connection to the Harbor. Reload to try again.");
      };
    };
    connect();
    // Which way your own hero turns to look goes to everyone else here.
    const unhear = gaze.onLook((look) => socket.current?.readyState === WebSocket.OPEN && socket.current.send(JSON.stringify({ type: "look", look })));
    const ping = setInterval(() => socket.current?.readyState === WebSocket.OPEN && socket.current.send("ping"), 25_000);
    return () => {
      closed = true;
      unhear();
      clearInterval(ping);
      clearTimeout(retry);
      socket.current?.close();
    };
  }, [awake]);

  const send = useCallback((message: HarborClientMessage) => {
    if (socket.current?.readyState !== WebSocket.OPEN) return;
    socket.current.send(JSON.stringify(message));
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
  return { you, crew, players, board, chat, status, error, trades, send };
}
