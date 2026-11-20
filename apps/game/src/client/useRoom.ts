// What the connections to the game's rooms share, so that each room's own
// hook (useHarbor, useHut, usePub, useZone) holds only what is particular to
// its room, and a new walk-in place does not copy one.
//
// useRoomSocket is the WebSocket itself: opening it, the ping that keeps it
// open, trying again with a growing pause when it drops, and saying why when
// it will not open. All of that is openRoomSocket, which knows nothing of
// React, so it can be tested with a stand-in socket (test/roomSocket.test.ts).
// useRoomPeople is who is in a walk-in place, as its room tells it (the
// Harbor, a hut and the pub all say it the same way): where each of them
// stands, the chat, and the walks, XP and chat lines the renderer is told of.

import { useCallback, useEffect, useRef, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import type { EmoteMessage, HarborPlayer, LookMessage, XpMessage } from "@gantt-quest/world";
import { emotes } from "./emotes";
import { PROFILE } from "./api";
import { gaze } from "./gaze";

export type RoomStatus = "connecting" | "open" | "closed";

/** What a room's connection is like: where it is, what it hears, and what it says when it cannot be had. */
export interface RoomSocketSpec<S> {
  /** The address to open, from the site's root. Asked for at every connection: it may say where to arrive. */
  path(): string;
  /** Every message the room sends, on the connection it came on. */
  onMessage(msg: S, ws: WebSocket): void;
  /** A connection has opened, the first or one made after a drop. */
  onOpen?(): void;
  /** Which way your own hero turns to look (gaze.ts) goes to everyone else here. */
  looks?: boolean;
  /** What to say when the room closed the connection because the place was opened in another tab. Nothing is tried again. */
  elsewhere: string;
  /** What to say once six tries in a row have failed. Left out: nothing is said, and the status stays "closed". */
  lost?: string;
  /**
   * What to do when a connection closes without one ever having opened. Left out: try again, as for one that dropped.
   * "ask": a browser cannot see why a WebSocket was turned away, so ask the same address over plain HTTP; a refusal
   * (403 or 409) comes back with its reason, which is shown, and anything else is tried again. `{ error }`: say
   * this, and try no more.
   */
  unopened?: "ask" | { error: string };
  /** An error stays up when a connection opens, for the view to clear. Left out: opening clears it. */
  keepError?: boolean;
}

export interface RoomSocketOptions<S> extends RoomSocketSpec<S> {
  /** A new connection is made from scratch when this changes (whose hut, which map). */
  key?: string;
  /** False while the player is away (awake.ts): the connection is closed, and the status is "paused" until they are back. */
  awake?: boolean;
}

export interface RoomSocket<Status> {
  status: Status;
  error: string | null;
  setError(error: string | null): void;
  /** Send a message, if the connection is open. Returns whether it was sent. */
  send(message: unknown): boolean;
}

/**
 * Open a room's connection and keep it: a ping every 25 seconds, and when it drops another try after a pause that
 * doubles from one second to eight, six times over. `spec` is asked for at each use, so what it gives may change
 * while the connection lives. `told` hears how the connection stands and what went wrong. Returns the way to send
 * on it and to close it for good (after which nothing more is told).
 */
export function openRoomSocket<S>(spec: () => RoomSocketSpec<S>, told: { status(status: RoomStatus): void; error(error: string | null): void }): { send(message: unknown): boolean; close(): void } {
  let socket: WebSocket | null = null;
  let closed = false;
  let attempts = 0;
  let everOpen = false;
  let retry: ReturnType<typeof setTimeout> | undefined;

  const connect = () => {
    const proto = location.protocol === "https:" ? "wss:" : "ws:";
    const path = spec().path();
    const ws = new WebSocket(`${proto}//${location.host}${path}`);
    socket = ws;
    told.status("connecting");
    ws.onopen = () => {
      attempts = 0;
      everOpen = true;
      told.status("open");
      if (!spec().keepError) told.error(null);
      spec().onOpen?.();
    };
    ws.onmessage = (e) => {
      if (e.data === "pong") return;
      spec().onMessage(JSON.parse(e.data) as S, ws);
    };
    ws.onclose = async (e) => {
      if (closed) return;
      const { elsewhere, lost, unopened } = spec();
      told.status("closed");
      if (e.code === 4000) return told.error(elsewhere);
      if (!everOpen && unopened) {
        if (unopened !== "ask") return told.error(unopened.error);
        const res = await fetch(path, { headers: PROFILE ? { "x-gq-profile": PROFILE } : {} }).catch(() => null);
        if (closed) return;
        if (res && (res.status === 403 || res.status === 409)) return told.error(await res.text());
      }
      if (attempts++ < 6) retry = setTimeout(connect, Math.min(8000, 500 * 2 ** attempts));
      else if (lost) told.error(lost);
    };
  };
  const send = (message: unknown) => {
    if (socket?.readyState !== WebSocket.OPEN) return false;
    socket.send(JSON.stringify(message));
    return true;
  };
  connect();
  const unhear = spec().looks ? gaze.onLook((look) => void send({ type: "look", look })) : undefined;
  const ping = setInterval(() => socket?.readyState === WebSocket.OPEN && socket.send("ping"), 25_000);
  return {
    send,
    close() {
      closed = true;
      unhear?.();
      clearInterval(ping);
      clearTimeout(retry);
      socket?.close();
    },
  };
}

/** A room's connection, for as long as the view that asks for it is up (and, where `awake` is given, the player is here). */
export function useRoomSocket<S>(room: RoomSocketOptions<S> & { awake: boolean }): RoomSocket<RoomStatus | "paused">;
export function useRoomSocket<S>(room: RoomSocketOptions<S>): RoomSocket<RoomStatus>;
export function useRoomSocket<S>(room: RoomSocketOptions<S>): RoomSocket<RoomStatus | "paused"> {
  const [status, setStatus] = useState<RoomStatus | "paused">("connecting");
  const [error, setError] = useState<string | null>(null);
  const live = useRef<ReturnType<typeof openRoomSocket> | null>(null);
  const latest = useRef(room);
  latest.current = room;
  const awake = room.awake ?? true;

  useEffect(() => {
    if (!awake) {
      setStatus("paused");
      return;
    }
    const opened = openRoomSocket(() => latest.current, { status: setStatus, error: setError });
    live.current = opened;
    return opened.close;
  }, [awake, room.key]);

  const send = useCallback((message: unknown) => live.current?.send(message) ?? false, []);
  return { status, error, setError, send };
}

/** One line of a place's chat. */
export interface ChatLine {
  name: string;
  text: string;
}

/** What the room of every walk-in place says about who is in it. */
export type PeopleMessage =
  | { type: "snapshot"; you: string; players: HarborPlayer[] }
  | { type: "joined"; player: HarborPlayer }
  | { type: "left"; id: string }
  | { type: "moved"; id: string; path: HexPos[] }
  | { type: "placed"; id: string; pos: HexPos }
  | { type: "said"; id: string; name: string; text: string }
  | LookMessage
  | EmoteMessage
  | XpMessage;

/**
 * Who is in a walk-in place. `hear` is given the room's messages about them: a room's own hook hands it every
 * message it does not deal with itself. `onMoved` fires for every walk, including your own, so the renderer can
 * animate it; `onXp` when someone here earns XP; `onSaid` for every chat line, yours too, so it can show it over
 * the speaker.
 */
export function useRoomPeople(onMoved: (id: string, path: HexPos[]) => void, onXp?: (m: XpMessage) => void, onSaid?: (id: string, text: string) => void) {
  const [you, setYou] = useState<string | null>(null);
  const [players, setPlayers] = useState<HarborPlayer[]>([]);
  const [chat, setChat] = useState<ChatLine[]>([]);
  const moved = useRef(onMoved);
  moved.current = onMoved;
  const xpSeen = useRef(onXp);
  xpSeen.current = onXp;
  const said = useRef(onSaid);
  said.current = onSaid;

  /** Tell the renderer of a walk (an empty one stops any walk under way), after React has applied where they now stand, so the walk is not snapped over. */
  const walked = useCallback((id: string, path: HexPos[]) => queueMicrotask(() => moved.current(id, path)), []);
  /** A line over someone's head, for everyone who can see them. */
  const overhead = useCallback((id: string, text: string) => said.current?.(id, text), []);
  const hear = useCallback((msg: PeopleMessage) => {
    if (msg.type === "snapshot") {
      setYou(msg.you);
      setPlayers(msg.players);
    } else if (msg.type === "joined") {
      setPlayers((ps) => [...ps.filter((p) => p.id !== msg.player.id), msg.player]);
    } else if (msg.type === "left") {
      setPlayers((ps) => ps.filter((p) => p.id !== msg.id));
    } else if (msg.type === "placed") {
      // Put straight there (a stuck hero sent back): an empty walk stops any walk under way, and the unit slides over.
      setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, pos: msg.pos } : p)));
      walked(msg.id, []);
    } else if (msg.type === "moved") {
      const end = msg.path[msg.path.length - 1];
      setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, pos: end } : p)));
      walked(msg.id, msg.path);
    } else if (msg.type === "xp") {
      // Someone here earned XP: their plate shows the new level and bar, then the sparkle plays.
      setPlayers((ps) => ps.map((p) => (p.id === msg.id ? { ...p, level: msg.level, xp: msg.xp } : p)));
      queueMicrotask(() => xpSeen.current?.(msg));
    } else if (msg.type === "looked") {
      gaze.looked(msg.id, msg.look);
    } else if (msg.type === "emoted") {
      emotes.emoted(msg.id, msg.emote);
    } else if (msg.type === "said") {
      setChat((c) => [...c, { name: msg.name, text: msg.text }].slice(-30));
      overhead(msg.id, msg.text);
    }
  }, [walked, overhead]);
  return { you, players, chat, setPlayers, walked, overhead, hear };
}
