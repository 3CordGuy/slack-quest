// WebSocket connection to a zone's ZoneRoom: the map's state as the server
// last told it, and a way to send what you do. Like useRun, it reconnects
// with a growing pause, and gives up when the zone has been opened in
// another tab.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ZoneAction, ZoneEvent, ZoneView } from "@gantt-quest/world";
import { PROFILE } from "./api";

/** An action as the client sends it: who it is from is the server's to say. */
export type ZoneSend = ZoneAction extends infer A ? (A extends { by: string } ? Omit<A, "by"> : never) : never;

export interface ZoneConnection {
  state: ZoneView | null;
  online: string[];
  status: "connecting" | "open" | "closed";
  error: string | null;
  /** Counts up whenever the player's trades may have changed (a crewmate changed one, or the connection is new): ask for them again. */
  trades: number;
  send(action: ZoneSend): void;
  /** Your gear has changed: have the server read your hero again. */
  resheet(): void;
  clearError(): void;
}

export function useZone(code: string, onUpdate: (state: ZoneView, events: ZoneEvent[], prev: ZoneView | null) => void): ZoneConnection {
  const [state, setState] = useState<ZoneView | null>(null);
  const [online, setOnline] = useState<string[]>([]);
  const [status, setStatus] = useState<ZoneConnection["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [trades, setTrades] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const latest = useRef<ZoneView | null>(null);
  const handler = useRef(onUpdate);
  handler.current = onUpdate;

  useEffect(() => {
    let closed = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let everOpened = false;
    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      // Arriving by teleport: the crewmate to turn up beside, said once.
      let near = "";
      try {
        near = sessionStorage.getItem("gq.zone.near") ?? "";
        sessionStorage.removeItem("gq.zone.near");
      } catch {
        // Storage is off: the map's start it is.
      }
      const query = [PROFILE && `p=${encodeURIComponent(PROFILE)}`, near && `near=${encodeURIComponent(near)}`].filter(Boolean).join("&");
      const ws = new WebSocket(`${proto}//${location.host}/api/zone/${code}/ws${query ? `?${query}` : ""}`);
      socket.current = ws;
      setStatus("connecting");
      ws.onopen = () => {
        attempts = 0;
        everOpened = true;
        setStatus("open");
        // A trade may have changed while there was no connection to hear of it.
        setTrades((n) => n + 1);
      };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        const msg = JSON.parse(e.data);
        if (msg.type === "update") {
          const prev = latest.current;
          latest.current = msg.state;
          setState(msg.state);
          setOnline(msg.online);
          handler.current(msg.state, msg.events, prev);
        } else if (msg.type === "error") {
          setError(msg.message);
        } else if (msg.type === "trades") {
          setTrades((n) => n + 1);
        }
      };
      ws.onclose = (e) => {
        if (closed) return;
        setStatus("closed");
        if (e.code === 4000) return setError("This map was opened in another tab.");
        if (!everOpened) return setError("Could not reach that map. Check the code, and that you have a character.");
        if (attempts++ < 6) retry = setTimeout(connect, Math.min(8000, 500 * 2 ** attempts));
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
  }, [code]);

  const send = useCallback((action: ZoneSend) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "action", action }));
  }, []);
  const resheet = useCallback(() => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "sheet" }));
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { state, online, status, error, trades, send, resheet, clearError };
}
