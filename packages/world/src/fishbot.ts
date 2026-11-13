// A simple angler for tests and tuning: taps through a fish's runs (easing
// off when the line is tight), holds through its rests. Not exported from
// the package; tests import it directly.

import { fightTick, pressureAt, startFight, type FightEase, type FightScript, type FightState } from "./fishfight";

export function playFight(script: FightScript, ease: FightEase, cautious = 0.8): { end: FightState; edges: number[] } {
  let s = startFight(script);
  const edges: number[] = [];
  let down = false;
  let downAt = -1e9;
  let lastDown = -1e9;
  const press = (t: number) => {
    edges.push(t);
    down = true;
    downAt = t;
    lastDown = t;
  };
  const release = (t: number) => {
    edges.push(t);
    down = false;
  };
  while (!s.outcome) {
    const t = s.t;
    const running = s.mode === "run" || s.mode === "shake" || s.mode === "jump";
    const want = !running ? "hold" : s.T > cautious ? "off" : "tap";
    if (want === "hold") {
      if (!down) press(t);
    } else if (want === "off") {
      if (down) release(t);
    } else if (down && t - downAt >= 100) release(t);
    else if (!down && t - lastDown >= 250) press(t);
    s = fightTick(s, script, ease, pressureAt(edges, t));
  }
  return { end: s, edges };
}

/** Holds the button the whole fight. */
export function holdFight(script: FightScript, ease: FightEase): FightState {
  let s = startFight(script);
  while (!s.outcome) s = fightTick(s, script, ease, 1);
  return s;
}

/** Never touches the button. */
export function idleFight(script: FightScript, ease: FightEase): FightState {
  let s = startFight(script);
  while (!s.outcome) s = fightTick(s, script, ease, 0);
  return s;
}
