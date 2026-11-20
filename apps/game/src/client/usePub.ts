// WebSocket connection to the crew's PubRoom: who is inside, where they
// stand, the chat, and the game tables. The connection itself and who is
// inside are useRoom.ts.
//
// The room has one message for each game's table and one for a request it
// refused there, named for the game ("dice", "diceError"). They are kept by
// that name, whatever the game, so a new table game needs nothing here: its
// messages in packages/world/src/pub.ts, and its entry in PubView's TABLES.

import { useEffect, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import type { HarborPlayer, PubClientMessage, PubServerMessage, XpMessage } from "@gantt-quest/world";
import { PROFILE } from "./api";
import { useRoomPeople, useRoomSocket, type ChatLine } from "./useRoom";

/** A game's table, as the room sends it: the message's `type` is the game. */
type TableMessage = Extract<PubServerMessage, { table: unknown }>;
/** Each game's table as this player may see it, by game. Null: nobody has opened one. */
export type PubTables = { [M in TableMessage as M["type"]]: M["table"] };
/** A request at a game's table that the room refused: "diceError" for "dice". */
type TableRefusal = Extract<PubServerMessage, { type: `${keyof PubTables}Error` }>;
const isRefusal = (msg: PubServerMessage): msg is TableRefusal => msg.type.endsWith("Error");
/** `map` with `key` set to `value`, or `map` itself where that changes nothing (left out is the same as null). */
const put = <M extends object, K extends keyof M>(map: M, key: K, value: M[K]): M => ((map[key] ?? null) === value ? map : { ...map, [key]: value });

export interface PubConnection {
  you: string | null;
  players: HarborPlayer[];
  chat: ChatLine[];
  /** The game tables, by game. A game the room has not spoken of yet is left out, which is the same as null. */
  tables: Partial<PubTables>;
  /** Why the last request at each game's table was refused. Cleared by the next change at that table. */
  tableErrors: Partial<Record<keyof PubTables, string | null>>;
  /** The last XP anyone here earned, for the tables' "won" line. */
  lastXp: XpMessage | null;
  /** "paused": closed while the pub is kept but put away (PubView's `resting`). */
  status: "connecting" | "open" | "closed" | "paused";
  error: string | null;
  send(message: PubClientMessage): void;
}

/**
 * `onMoved` fires for every walk, including your own, so the renderer can animate it; `onSaid` for every chat line, yours too, so it can show it over the speaker.
 * `here`: false while the pub is kept but put away, with the player somewhere else. There is no connection then.
 * Who was inside is remembered as they stood, so the room is not empty for the moment between walking in and the
 * room saying who is there now.
 */
export function usePub(onMoved: (id: string, path: HexPos[]) => void, onXp?: (m: XpMessage) => void, onSaid?: (id: string, text: string) => void, here = true): PubConnection {
  const [tables, setTables] = useState<PubConnection["tables"]>({});
  const [tableErrors, setTableErrors] = useState<PubConnection["tableErrors"]>({});
  const [lastXp, setLastXp] = useState<XpMessage | null>(null);
  const people = useRoomPeople(onMoved, onXp, onSaid);

  useEffect(() => {
    if (here) return;
    setTables({});
    setTableErrors({});
  }, [here]);

  const socket = useRoomSocket<PubServerMessage>({
    awake: here,
    looks: true,
    elsewhere: "The pub is open in another tab.",
    lost: "Lost the connection to the pub. Reload to try again.",
    unopened: "ask",
    path: () => `/api/pub/ws${PROFILE ? `?p=${PROFILE}` : ""}`,
    onMessage(msg) {
      if (msg.type === "bubble") {
        // Over their head only: a word with the barkeep, which stays out of the room's chat log.
        people.overhead(msg.id, msg.text);
      } else if ("table" in msg) {
        // A game's table has changed, which also answers whatever was refused there.
        setTables((t) => put(t, msg.type, msg.table));
        setTableErrors((e) => put(e, msg.type, null));
      } else if (isRefusal(msg)) {
        const game = msg.type.slice(0, -"Error".length) as keyof PubTables;
        setTableErrors((e) => put(e, game, msg.text));
      } else {
        if (msg.type === "xp") setLastXp(msg);
        people.hear(msg);
      }
    },
  });

  return { you: people.you, players: people.players, chat: people.chat, tables, tableErrors, lastXp, status: socket.status, error: socket.error, send: socket.send };
}
