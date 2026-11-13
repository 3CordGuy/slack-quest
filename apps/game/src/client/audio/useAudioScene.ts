import { useEffect, useRef } from "react";
import { audio } from "./engine";
import type { SceneName } from "./types";

/**
 * Say which scene a view is: its music and atmosphere play while it is on
 * screen. A view opened over another (the sparring ring over the Harbor) wins
 * until it closes. Pass null for silence.
 */
export function useAudioScene(scene: SceneName | null) {
  const handle = useRef<number | null>(null);
  const latest = useRef(scene);
  latest.current = scene;
  useEffect(() => {
    const id = audio.pushScene(latest.current);
    handle.current = id;
    return () => {
      audio.popScene(id);
      handle.current = null;
    };
  }, []);
  useEffect(() => {
    if (handle.current !== null) audio.setScene(handle.current, scene);
  }, [scene]);
}
