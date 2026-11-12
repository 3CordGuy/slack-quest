// WebSocket connection to the crew's PubRoom: who is inside, where they
// stand, the chat, and the dice table. Modelled on useHut.

import { useCallback, useEffect, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import type { DiceView, HarborPlayer, PubClientMessage, PubServerMessage, ShoalsView, XpMessage } from "@gantt-quest/world";
import { PROFILE } from "./api";
import type { HarborChatLine } from "./useHarbor";

export interface PubConnection {
  you: string | null;
  players: HarborPlayer[];
  chat: HarborChatLine[];
  /** The dice table as this player may see it, or null when nobody has opened one. */
  dice: DiceView | null;
  /** Why the last dice request was refused. Cleared by the next change at the table. */
  diceError: string | null;
  /** The Shoals table, likewise. */
  shoals: ShoalsView | null;
  shoalsError: string | null;
  /** The last XP anyone here earned, for the tables' "won" line. */
  lastXp: XpMessage | null;
  status: "connecting" | "open" | "closed";
  error: string | null;
  send(message: PubClientMessage): void;
}

/** `onMoved` fires for every walk, including your own, so the renderer can animate it; `onSaid` for every chat line, yours too, so it can show it over the speaker. */
export function usePub(onMoved: (id: string, path: HexPos[]) => void, onXp?: (m: XpMessage) => void, onSaid?: (id: string, text: string) => void): PubConnection {
  const [you, setYou] = useState<string | null>(null);
  const [players, setPlayers] = useState<HarborPlayer[]>([]);
  const [chat, setChat] = useState<HarborChatLine[]>([]);
  const [dice, setDice] = useState<DiceView | null>(null);
  const [diceError, setDiceError] = useState<string | null>(null);
  const [shoals, setShoals] = useState<ShoalsView | null>(null);
  const [shoalsError, setShoalsError] = useState<string | null>(null);
  const [lastXp, setLastXp] = useState<XpMessage | null>(null);
  const [status, setStatus] = useState<PubConnection["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const moved = useRef(onMoved);
  moved.current = onMoved;
  const xpSeen = useRef(onXp);
  xpSeen.current = onXp;
  const said = useRef(onSaid);
  said.current = onSaid;

  useEffect(() => {
    let closed = false;
    let attempts = 0;
    let everOpen = false;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const path = `/api/pub/ws${PROFILE ? `?p=${PROFILE}` : ""}`;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}${path}`);
      socket.current = ws;
      setStatus("connecting");
      ws.onopen = () => {
        attempts = 0;
        everOpen = true;
        setStatus("open");
        setError(null);
      };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        const msg = JSON.parse(e.data) as PubServerMessage;
        if (msg.type === "snapshot") {
          setYou(msg.you);
          setPlayers(msg.players);
        } else if (msg.type === "joined") {
          setPlayers((ps) => [...ps.filter((p) => p.id !== msg.player.id), msg.player]);
        } else if (msg.type === "left") {
          setPlayers((ps) => ps.filter((p) => p.id !== msg.id));
        } else if (msg.type === "moved") {
          const end = msg.path[msg.path.length - 1];
          setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, pos: end } : p)));
          // After React has applied the new position, so the walk is not snapped over.
          queueMicrotask(() => moved.current(msg.id, msg.path));
        } else if (msg.type === "xp") {
          // Someone here earned XP: their plate shows the new level and bar, then the sparkle plays.
          setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, level: msg.level, xp: msg.xp } : p)));
          setLastXp(msg);
          queueMicrotask(() => xpSeen.current?.(msg));
        } else if (msg.type === "said") {
          setChat((c) => [...c, { name: msg.name, text: msg.text }].slice(-30));
          // Over their head too, for everyone who can see them.
          said.current?.(msg.id, msg.text);
        } else if (msg.type === "dice") {
          setDice(msg.table);
          setDiceError(null);
        } else if (msg.type === "diceError") {
          setDiceError(msg.text);
        } else if (msg.type === "shoals") {
          setShoals(msg.table);
          setShoalsError(null);
        } else if (msg.type === "shoalsError") {
          setShoalsError(msg.text);
        }
      };
      ws.onclose = async (e) => {
        if (closed) return;
        setStatus("closed");
        if (e.code === 4000) return setError("The pub is open in another tab.");
        if (!everOpen) {
          // A browser cannot see why a WebSocket was turned away, so ask the same address over plain HTTP.
          const res = await fetch(path, { headers: PROFILE ? { "x-gq-profile": PROFILE } : {} }).catch(() => null);
          if (closed) return;
          if (res && (res.status === 403 || res.status === 409)) return setError(await res.text());
        }
        if (attempts++ < 6) retry = setTimeout(connect, Math.min(8000, 500 * 2 ** attempts));
        else setError("Lost the connection to the pub. Reload to try again.");
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

  const send = useCallback((message: PubClientMessage) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);
  return { you, players, chat, dice, diceError, shoals, shoalsError, lastXp, status, error, send };
}
