// The bridge between the dev toolbox and the zone on screen. The toolbox
// sits beside every view and knows nothing of what is open; a zone, while
// it is open, registers itself here so the toolbox's Maps tab can send it
// dev actions and arm a tool that takes its next clicks on the map (place
// a group, paint a surface).

import { useSyncExternalStore } from "react";
import type { DevOp, SurfaceKind } from "@gantt-quest/world";

/** A tool that takes clicks on the map until it is put down. */
export type ZoneDevTool = { tool: "spawn"; kinds: string[] } | { tool: "paint"; surface: SurfaceKind | null; wide: boolean };

export interface ZoneDevState {
  /** The zone on screen, if there is one. */
  open: { code: string; seed?: string; send(op: DevOp): void } | null;
  tool: ZoneDevTool | null;
  /** Draw each group's alert radius on the map. */
  showAlert: boolean;
  /** The heroes on the map that are yours to play (yourself, and stand-ins), for the Maps tab to change. */
  heroes: KitHero[];
}

export interface KitHero {
  id: string;
  name: string;
  classId: string;
  level: number;
  /** The weapon in hand, by id, if it is one of the class weapons. */
  weapon?: string;
  abilities: string[];
}

let state: ZoneDevState = { open: null, tool: null, showAlert: false, heroes: [] };
const listeners = new Set<() => void>();

export function setZoneDev(next: Partial<ZoneDevState>): void {
  state = { ...state, ...next };
  for (const tell of listeners) tell();
}

export function useZoneDev(): ZoneDevState {
  return useSyncExternalStore(
    (tell) => {
      listeners.add(tell);
      return () => listeners.delete(tell);
    },
    () => state,
  );
}
