// WebSocket connection to a zone's ZoneRoom: the map's state as the server
// last told it, and a way to send what you do. Like useRun, it reconnects
// with a growing pause, and gives up when the zone has been opened in
// another tab.
//
// Each action sent carries a number, and the server's answer to it (the
// update that shows what it did, or the error that refused it) carries the
// number back, so the view can show an action at once and put the picture
// right when its answer comes (zone/ahead.ts). Only a server that says it
// answers numbers (`acks` on its updates) is taken at its word for that: to
// one that does not, actions are sent as they always were and nothing is
// shown ahead.
//
// A map's tiles never change, and they are most of what a state weighs. The
// connection says it keeps them (`lean`), so the server sends them with the
// first update only, and they are carried over into every one after.

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
  /** Send an action. Returns the number its answer will carry, or null if no answer to it can be waited on (no connection, or a server that does not number its answers). */
  send(action: ZoneSend): number | null;
  /** Your gear has changed: have the server read your hero again. */
  resheet(): void;
  clearError(): void;
}

/** What the view is told as answers arrive. */
export interface ZoneHandlers {
  /** A new state, with what happened. `ack`: the number of the action of yours it answers, if it answers one. */
  onUpdate(state: ZoneView, events: ZoneEvent[], prev: ZoneView | null, ack: number | undefined): void;
  /** The server refused your action with this number. */
  onRefused(n: number): void;
}

export function useZone(code: string, handlers: ZoneHandlers): ZoneConnection {
  const [state, setState] = useState<ZoneView | null>(null);
  const [online, setOnline] = useState<string[]>([]);
  const [status, setStatus] = useState<ZoneConnection["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const [trades, setTrades] = useState(0);
  const socket = useRef<WebSocket | null>(null);
  const latest = useRef<ZoneView | null>(null);
  const handler = useRef(handlers);
  handler.current = handlers;
  /** The number the next action sent will carry. */
  const sent = useRef(0);
  /** Whether the server on this connection sends an action's number back with its answer. */
  const answers = useRef(false);

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
      const query = ["lean=1", PROFILE && `p=${encodeURIComponent(PROFILE)}`, near && `near=${encodeURIComponent(near)}`].filter(Boolean).join("&");
      const ws = new WebSocket(`${proto}//${location.host}/api/zone/${code}/ws?${query}`);
      /** The map's tiles, as this connection was first sent them. */
      let tiles: ZoneView["map"]["tiles"] | null = null;
      socket.current = ws;
      answers.current = false;
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
          // The tiles came with this connection's first update; later ones leave them out.
          if (msg.state.map.tiles) tiles = msg.state.map.tiles;
          else if (tiles) msg.state.map.tiles = tiles;
          // An update with no tiles to go with it cannot be drawn: start again with a fresh connection, which is sent them.
          else return ws.close();
          answers.current = msg.acks === true;
          const prev = latest.current;
          latest.current = msg.state;
          setState(msg.state);
          setOnline(msg.online);
          handler.current.onUpdate(msg.state, msg.events, prev, typeof msg.ack === "number" ? msg.ack : undefined);
        } else if (msg.type === "error") {
          setError(msg.message);
          if (typeof msg.ack === "number") handler.current.onRefused(msg.ack);
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
    if (socket.current?.readyState !== WebSocket.OPEN) return null;
    const n = ++sent.current;
    socket.current.send(JSON.stringify({ type: "action", action, n }));
    return answers.current ? n : null;
  }, []);
  const resheet = useCallback(() => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "sheet" }));
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { state, online, status, error, trades, send, resheet, clearError };
}
