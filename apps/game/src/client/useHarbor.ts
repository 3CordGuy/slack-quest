// WebSocket connection to the crew's HarborRoom: who is here, where they
// stand, and what is on the notice board.

import { useCallback, useEffect, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import { HARBOR_NAME, type HarborBoard, type HarborClientMessage, type HarborPlayer, type HarborServerMessage, type XpMessage } from "@gantt-quest/world";
import { PROFILE } from "./api";

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
  status: "connecting" | "open" | "closed";
  error: string | null;
  send(message: HarborClientMessage): void;
}

const EMPTY: HarborBoard = { members: [], ships: [], log: [] };

/** `onMoved` fires for every walk, including your own, so the renderer can animate it. */
export function useHarbor(onMoved: (id: string, path: HexPos[]) => void, onXp?: (m: XpMessage) => void): HarborConnection {
  const [you, setYou] = useState<string | null>(null);
  const [crew, setCrew] = useState<HarborConnection["crew"]>(null);
  const [players, setPlayers] = useState<HarborPlayer[]>([]);
  const [board, setBoard] = useState<HarborBoard>(EMPTY);
  const [chat, setChat] = useState<HarborChatLine[]>([]);
  const [status, setStatus] = useState<HarborConnection["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const moved = useRef(onMoved);
  moved.current = onMoved;
  const xpSeen = useRef(onXp);
  xpSeen.current = onXp;

  useEffect(() => {
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
          setBoard({ members: msg.members, ships: msg.ships, log: msg.log, works: msg.works });
        } else if (msg.type === "board") {
          setBoard({ members: msg.members, ships: msg.ships, log: msg.log, works: msg.works });
        } else if (msg.type === "joined") {
          setPlayers((ps) => [...ps.filter((p) => p.id !== msg.player.id), msg.player]);
        } else if (msg.type === "left") {
          setPlayers((ps) => ps.filter((p) => p.id !== msg.id));
        } else if (msg.type === "moved") {
          const end = msg.path[msg.path.length - 1];
          // Walking off rolls their bedroll back up.
          setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, pos: end, bedroll: undefined } : p)));
          // After React has applied the new position, so the walk is not snapped over.
          queueMicrotask(() => moved.current(msg.id, msg.path));
        } else if (msg.type === "xp") {
          // Someone here earned XP: their plate shows the new level and bar, then the sparkle plays.
          setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, level: msg.level, xp: msg.xp } : p)));
          queueMicrotask(() => xpSeen.current?.(msg));
        } else if (msg.type === "said") {
          setChat((c) => [...c, { name: msg.name, text: msg.text }].slice(-30));
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
    const ping = setInterval(() => socket.current?.readyState === WebSocket.OPEN && socket.current.send("ping"), 25_000);
    return () => {
      closed = true;
      clearInterval(ping);
      clearTimeout(retry);
      socket.current?.close();
    };
  }, []);

  const send = useCallback((message: HarborClientMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);
  return { you, crew, players, board, chat, status, error, send };
}
