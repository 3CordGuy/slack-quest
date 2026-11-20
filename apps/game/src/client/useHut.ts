// WebSocket connection to a hut's HutRoom: who is inside, where they stand,
// and the furniture. The connection itself and who is inside are useRoom.ts.

import { useCallback, useState } from "react";
import type { HexPos } from "@gantt-quest/core";
import type { Furnishing, HarborPlayer, HutClientMessage, HutServerMessage, XpMessage } from "@gantt-quest/world";
import { PROFILE } from "./api";
import { useRoomPeople, useRoomSocket, type ChatLine } from "./useRoom";

export interface HutConnection {
  you: string | null;
  owner: { id: string; name: string } | null;
  /** Null until the first snapshot arrives. */
  tier: number | null;
  canEdit: boolean;
  players: HarborPlayer[];
  /** Everything the owner has, placed (q/r set) and stored. */
  furnishings: Furnishing[];
  chat: ChatLine[];
  status: "connecting" | "open" | "closed";
  /** The connection failed, or the hut is not yours to enter. */
  error: string | null;
  /** The last thing the server would not do, e.g. placing on the doorway. Cleared by the next change. */
  refused: string | null;
  send(message: HutClientMessage): void;
}

/** `onMoved` fires for every walk, including your own, so the renderer can animate it; `onSaid` for every chat line, yours too, so it can show it over the speaker. */
export function useHut(ownerId: string, onMoved: (id: string, path: HexPos[]) => void, onXp?: (m: XpMessage) => void, onSaid?: (id: string, text: string) => void): HutConnection {
  const [owner, setOwner] = useState<HutConnection["owner"]>(null);
  const [tier, setTier] = useState<number | null>(null);
  const [canEdit, setCanEdit] = useState(false);
  const [furnishings, setFurnishings] = useState<Furnishing[]>([]);
  const [refused, setRefused] = useState<string | null>(null);
  const people = useRoomPeople(onMoved, onXp, onSaid);

  const socket = useRoomSocket<HutServerMessage>({
    key: ownerId,
    looks: true,
    elsewhere: "This hut is open in another tab.",
    lost: "Lost the connection to the hut. Reload to try again.",
    // A hut that is not yours to enter says so.
    unopened: "ask",
    path: () => `/api/hut/${encodeURIComponent(ownerId)}/ws${PROFILE ? `?p=${PROFILE}` : ""}`,
    onMessage(msg) {
      if (msg.type === "snapshot") {
        people.hear(msg);
        setOwner(msg.owner);
        setTier(msg.tier);
        setCanEdit(msg.canEdit);
        setFurnishings(msg.furnishings);
      } else if (msg.type === "furnishings") {
        setTier(msg.tier);
        setFurnishings(msg.furnishings);
        setRefused(null);
      } else if (msg.type === "refused") {
        setRefused(msg.reason);
      } else {
        people.hear(msg);
      }
    },
  });

  const post = socket.send;
  const send = useCallback((message: HutClientMessage) => {
    if (message.type !== "move" && message.type !== "say") setRefused(null);
    post(message);
  }, []);
  return { you: people.you, owner, tier, canEdit, players: people.players, furnishings, chat: people.chat, status: socket.status, error: socket.error, refused, send };
}
