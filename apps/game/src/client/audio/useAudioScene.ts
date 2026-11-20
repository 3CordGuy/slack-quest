import { useEffect, useRef } from "react";
import { audio } from "./engine";
import type { SceneName } from "./types";

/**
 * Say which scene a view is: its music and atmosphere play while it is on
 * screen. A view opened over another wins
 * until it closes. Pass null for silence. `on`: false while the view is kept but put away
 * (a building loaded with the game, the Harbor behind one): it has no say until it is back.
 */
export function useAudioScene(scene: SceneName | null, on = true) {
  const handle = useRef<number | null>(null);
  const latest = useRef(scene);
  latest.current = scene;
  useEffect(() => {
    if (!on) return;
    const id = audio.pushScene(latest.current);
    handle.current = id;
    return () => {
      audio.popScene(id);
      handle.current = null;
    };
  }, [on]);
  useEffect(() => {
    if (handle.current !== null) audio.setScene(handle.current, scene);
  }, [scene]);
}
