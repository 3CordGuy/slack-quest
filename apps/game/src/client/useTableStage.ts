// What the dice and Shoals panels share about sitting at a table in the world:
// dropping the camera into the table's scene (render/TableStage.ts) for as
// long as the panel is up, and setting everyone round it from your seat.

import { useEffect, useRef, useState, type RefObject } from "react";
import type { HexPos } from "@gantt-quest/core";
import type { Outfit } from "@gantt-quest/world";
import { TableStage, type SeatInfo, type TableAction, type TableKind } from "./render/TableStage";
import type { WorldRenderer } from "./render/WorldRenderer";

/** How someone at a table is drawn. */
export interface SeatLook {
  classId: string;
  outfit?: Outfit;
}

export interface StageHost {
  world: RefObject<WorldRenderer | null>;
  /** The table's hex, and who is standing on it (they are drawn by the table, not by the room). */
  hex: HexPos;
  hide: string[];
  /** Get up: the camera has come back out and the player may walk off. */
  onStand(): void;
}

/**
 * Put the camera in the table's scene while mounted. `pick` hears clicks on
 * markers in the scene; `okToStand` is asked before Escape gets you up (it is
 * where leaving a game in progress is confirmed). Returns the stage once it is
 * up, and `standUp`, which flies back out (and then calls `onStand`).
 */
export function useTableStage(kind: TableKind, host: StageHost, pick: (a: TableAction) => void, okToStand: () => boolean) {
  const [stage, setStage] = useState<TableStage | null>(null);
  const standRef = useRef<(() => void) | null>(null);
  const latest = useRef({ host, pick, okToStand });
  latest.current = { host, pick, okToStand };
  const hiddenKey = host.hide.join(",");

  useEffect(() => {
    const r = latest.current.host.world.current;
    if (!r) return;
    const s = r.startMinigame(
      (group) =>
        new TableStage(r, group, kind, {
          pick: (a) => latest.current.pick(a),
          stand: () => latest.current.okToStand() && standUp(),
          left: () => latest.current.host.onStand(),
        }),
      latest.current.host.hex,
      kind,
    );
    const standUp = () => s.leave();
    standRef.current = standUp;
    setStage(s);
    return () => {
      standRef.current = null;
      // Whoever unmounts first: the table's own `left` calls this too, and ending twice is harmless.
      if (r.playing === s) r.endMinigame();
      s.dispose();
      setStage(null);
    };
    // One table at one hex for the life of the panel.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  // Everyone on the table's hex is drawn by the table.
  useEffect(() => {
    const r = latest.current.host.world.current;
    if (!stage || !r) return;
    r.setStageHidden(host.hide);
  }, [stage, hiddenKey]);

  return { stage, standUp: () => standRef.current?.() };
}

/**
 * Seats go round the table from yours. Before a game every chair is set out,
 * empty ones too. If you are not seated you stand at slot 0, with the seated
 * after you, so the table never has someone in the spot your eyes are.
 */
export function placeSeats<S extends { id: string }>(seats: S[], you: string, open: boolean, max: number): { chairs: number; placed: (S | undefined)[] } {
  const start = seats.findIndex((s) => s.id === you);
  const seated = start >= 0;
  const chairs = (open ? max : seats.length) + (seated ? 0 : 1);
  const placed = Array.from({ length: chairs }, (_, i): S | undefined => {
    if (seated) return i < seats.length ? seats[(i + start) % seats.length] : undefined;
    return i >= 1 && i - 1 < seats.length ? seats[i - 1] : undefined;
  });
  return { chairs, placed };
}

/** The pieces of a seat's look that do not depend on the game. */
export function seatInfo(s: { id: string; name: string }, look: SeatLook | undefined, rest: Pick<SeatInfo, "turn" | "out" | "won" | "chip" | "pips" | "stars">): SeatInfo {
  return { id: s.id, name: s.name, classId: look?.classId ?? "npc", outfit: look?.outfit, ...rest };
}
