// WebSocket connection to a voyage's RunRoom.

import { useCallback, useEffect, useRef, useState } from "react";
import type { ClientState, WorldAction, WorldEvent } from "@gantt-quest/world";
import { PROFILE } from "./api";

type Outgoing = WorldAction extends infer A ? (A extends { heroId: string } ? Omit<A, "heroId"> : never) : never;

/** Votes to skip the turn in progress: whose turn, who has voted, and how many votes it takes. */
export interface SkipVote {
  heroId: string;
  votes: string[];
  needed: number;
}

export interface RunConnection {
  state: ClientState | null;
  online: string[];
  skip: SkipVote | null;
  /** Vote to end the current hero's turn now, as the turn timer would. */
  voteSkip(): void;
  status: "connecting" | "open" | "closed";
  error: string | null;
  send(action: Outgoing): void;
  /** Tell the voyage this hero's equipped gear changed, so it re-reads it. */
  regear(): void;
  clearError(): void;
}

export function useRun(code: string, onEvents: (events: WorldEvent[], state: ClientState) => void): RunConnection {
  const [state, setState] = useState<ClientState | null>(null);
  const [online, setOnline] = useState<string[]>([]);
  const [skip, setSkip] = useState<SkipVote | null>(null);
  const [status, setStatus] = useState<RunConnection["status"]>("connecting");
  const [error, setError] = useState<string | null>(null);
  const socket = useRef<WebSocket | null>(null);
  const handler = useRef(onEvents);
  handler.current = onEvents;

  useEffect(() => {
    let closed = false;
    let attempts = 0;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let everOpened = false;

    const connect = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/api/run/${code}/ws${PROFILE ? `?p=${PROFILE}` : ""}`);
      socket.current = ws;
      setStatus("connecting");
      ws.onopen = () => {
        attempts = 0;
        everOpened = true;
        setStatus("open");
      };
      ws.onmessage = (e) => {
        if (e.data === "pong") return;
        const msg = JSON.parse(e.data);
        if (msg.type === "update") {
          setState(msg.state);
          setOnline(msg.online);
          setSkip(msg.skip ?? null);
          handler.current(msg.events, msg.state);
        } else if (msg.type === "error") {
          setError(msg.message);
        }
      };
      ws.onclose = (e) => {
        if (closed) return;
        setStatus("closed");
        if (e.code === 4000) return setError("This voyage was opened in another tab.");
        if (!everOpened) return setError("Could not board that ship. Check the code, and that you have a character.");
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

  const send = useCallback((action: Outgoing) => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "action", action }));
  }, []);
  const regear = useCallback(() => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "regear" }));
  }, []);
  const voteSkip = useCallback(() => {
    if (socket.current?.readyState === WebSocket.OPEN) socket.current.send(JSON.stringify({ type: "vote_skip" }));
  }, []);
  const clearError = useCallback(() => setError(null), []);
  return { state, online, skip, voteSkip, status, error, send, regear, clearError };
}
