// WebSocket connection to a zone's ZoneRoom: the map's state as the server
// last told it, and a way to send what you do. The connection itself is
// useRoom.ts: it reconnects with a growing pause, and gives up when the zone
// has been opened in another tab, or when it could never be opened at all.
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

import { useCallback, useRef, useState } from "react";
import type { ZoneAction, ZoneEvent, ZoneView } from "@gantt-quest/world";
import { PROFILE } from "./api";
import { useRoomSocket } from "./useRoom";

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

/** What the room sends, as far as it is read here. */
type ZoneMessage =
  | { type: "update"; state: ZoneView; events: ZoneEvent[]; online: string[]; acks?: unknown; ack?: unknown }
  | { type: "error"; message: string; ack?: unknown }
  | { type: "trades" };

export function useZone(code: string, handlers: ZoneHandlers): ZoneConnection {
  const [state, setState] = useState<ZoneView | null>(null);
  const [online, setOnline] = useState<string[]>([]);
  const [trades, setTrades] = useState(0);
  const latest = useRef<ZoneView | null>(null);
  const handler = useRef(handlers);
  handler.current = handlers;
  /** The number the next action sent will carry. */
  const sent = useRef(0);
  /** Whether the server on this connection sends an action's number back with its answer. */
  const answers = useRef(false);
  /** The map's tiles, as this connection was first sent them. */
  const tiles = useRef<ZoneView["map"]["tiles"] | null>(null);

  const socket = useRoomSocket<ZoneMessage>({
    key: code,
    elsewhere: "This map was opened in another tab.",
    unopened: { error: "Could not reach that map. Check the code, and that you have a character." },
    // What the map refused stays up through a reconnection, until the view clears it.
    keepError: true,
    path() {
      // Arriving by teleport: the crewmate to turn up beside, said once.
      let near = "";
      try {
        near = sessionStorage.getItem("gq.zone.near") ?? "";
        sessionStorage.removeItem("gq.zone.near");
      } catch {
        // Storage is off: the map's start it is.
      }
      const query = ["lean=1", PROFILE && `p=${encodeURIComponent(PROFILE)}`, near && `near=${encodeURIComponent(near)}`].filter(Boolean).join("&");
      return `/api/zone/${code}/ws?${query}`;
    },
    onOpen() {
      // A new connection: nothing is known of it yet.
      answers.current = false;
      tiles.current = null;
      // A trade may have changed while there was no connection to hear of it.
      setTrades((n) => n + 1);
    },
    onMessage(msg, ws) {
      if (msg.type === "update") {
        // The tiles came with this connection's first update; later ones leave them out.
        if (msg.state.map.tiles) tiles.current = msg.state.map.tiles;
        else if (tiles.current) msg.state.map.tiles = tiles.current;
        // An update with no tiles to go with it cannot be drawn: start again with a fresh connection, which is sent them.
        else return ws.close();
        answers.current = msg.acks === true;
        const prev = latest.current;
        latest.current = msg.state;
        setState(msg.state);
        setOnline(msg.online);
        handler.current.onUpdate(msg.state, msg.events, prev, typeof msg.ack === "number" ? msg.ack : undefined);
      } else if (msg.type === "error") {
        socket.setError(msg.message);
        if (typeof msg.ack === "number") handler.current.onRefused(msg.ack);
      } else if (msg.type === "trades") {
        setTrades((n) => n + 1);
      }
    },
  });

  const { send: post, setError } = socket;
  const send = useCallback((action: ZoneSend) => {
    // The number is used up only by an action that was sent.
    const n = sent.current + 1;
    if (!post({ type: "action", action, n })) return null;
    sent.current = n;
    return answers.current ? n : null;
  }, []);
  const resheet = useCallback(() => {
    post({ type: "sheet" });
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { state, online, status: socket.status, error: socket.error, trades, send, resheet, clearError };
}
