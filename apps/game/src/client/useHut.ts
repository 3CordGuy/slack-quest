// WebSocket connection to a hut's HutRoom: who is inside, where they stand,
// and the furniture. Modelled on useHarbor.

import { useCallback, useEffect, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import type { Furnishing, HarborPlayer, HutClientMessage, HutServerMessage, XpMessage } from "@gantt-quest/world";
import { PROFILE } from "./api";
import type { HarborChatLine } from "./useHarbor";

export interface HutConnection {
  you: string | null;
  owner: { id: string; name: string } | null;
  /** Null until the first snapshot arrives. */
  tier: number | null;
  canEdit: boolean;
  players: HarborPlayer[];
  /** Everything the owner has, placed (q/r set) and stored. */
  furnishings: Furnishing[];
  chat: HarborChatLine[];
  status: "connecting" | "open" | "closed";
  /** The connection failed, or the hut is not yours to enter. */
  error: string | null;
  /** The last thing the server would not do, e.g. placing on the doorway. Cleared by the next change. */
  refused: string | null;
  send(message: HutClientMessage): void;
}

/** `onMoved` fires for every walk, including your own, so the renderer can animate it; `onSaid` for every chat line, yours too, so it can show it over the speaker. */
export function useHut(ownerId: string, onMoved: (id: string, path: HexPos[]) => void, onXp?: (m: XpMessage) => void, onSaid?: (id: string, text: string) => void): HutConnection {
  const [you, setYou] = useState<string | null>(null);
  const [owner, setOwner] = useState<HutConnection["owner"]>(null);
  const [tier, setTier] = useState<number | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [players, setPlayers] = useState<HarborPlayer[]>([]);
  const [furnishings, setFurnishings] = useState<Furnishing[]>([]);
  const [chat, setChat] = useState<HarborChatLine[]>([]);
  const [status, setStatus] = useState<HutConnection["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [refused, setRefused] = useState<string | null>(null);
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
    const path = `/api/hut/${encodeURIComponent(ownerId)}/ws${PROFILE ? `?p=${PROFILE}` : ""}`;

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
        const msg = JSON.parse(e.data) as HutServerMessage;
        if (msg.type === "snapshot") {
          setYou(msg.you);
          setOwner(msg.owner);
          setTier(msg.tier);
          setCanEdit(msg.canEdit);
          setPlayers(msg.players);
          setFurnishings(msg.furnishings);
        } else if (msg.type === "furnishings") {
          setTier(msg.tier);
          setFurnishings(msg.furnishings);
          setRefused(null);
        } else if (msg.type === "refused") {
          setRefused(msg.reason);
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
          queueMicrotask(() => xpSeen.current?.(msg));
        } else if (msg.type === "said") {
          setChat((c) => [...c, { name: msg.name, text: msg.text }].slice(-30));
          // Over their head too, for everyone who can see them.
          said.current?.(msg.id, msg.text);
        }
      };
      ws.onclose = async (e) => {
        if (closed) return;
        setStatus("closed");
        if (e.code === 4000) return setError("This hut is open in another tab.");
        if (!everOpen) {
          // A browser cannot see why a WebSocket was turned away, so ask the
          // same address over plain HTTP: a refusal comes back with its reason.
          const res = await fetch(path, { headers: PROFILE ? { "x-gq-profile": PROFILE } : {} }).catch(() => null);
          if (closed) return;
          if (res && (res.status === 403 || res.status === 409)) return setError(await res.text());
        }
        if (attempts++ < 6) retry = setTimeout(connect, Math.min(8000, 500 * 2 ** attempts));
        else setError("Lost the connection to the hut. Reload to try again.");
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
  }, [ownerId]);

  const send = useCallback((message: HutClientMessage) => {
    if (message.type !== "move" && message.type !== "say") setRefused(null);
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify(message));
  }, []);
  return { you, owner, tier, canEdit, players, furnishings, chat, status, error, refused, send };
}
