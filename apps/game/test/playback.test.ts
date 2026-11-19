// Playing out a fight: things are shown at their times, and the clock stops while a blow is on its way.

import { describe, expect, it } from "vitest";
import { playback, type PlaybackClock } from "../src/client/zone/playback";

/** A clock moved by hand, with timers that go off as it passes them. */
function handClock() {
  let now = 0;
  let id = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  const clock: PlaybackClock = {
    now: () => now,
    set: (run, ms) => {
      timers.set(++id, { at: now + Math.max(0, ms), run });
      return id;
    },
    clear: (handle) => void timers.delete(handle as number),
  };
  const advance = (ms: number) => {
    const until = now + ms;
    for (;;) {
      const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
      if (!due) break;
      timers.delete(due[0]);
      now = due[1].at;
      due[1].run();
    }
    now = until;
  };
  return { clock, advance };
}

describe("playing out a fight", () => {
  it("shows each thing at its time, and nothing there and then", () => {
    const { clock, advance } = handClock();
    const play = playback(clock);
    const seen: string[] = [];
    play.at(0, () => seen.push("swing"));
    play.at(300, () => seen.push("next"));
    expect(seen).toEqual([]);
    advance(0);
    expect(seen).toEqual(["swing"]);
    advance(299);
    expect(seen).toEqual(["swing"]);
    advance(1);
    expect(seen).toEqual(["swing", "next"]);
  });

  it("holds what comes of a blow, and everything after it, till the blow lands", () => {
    const { clock, advance } = handClock();
    const play = playback(clock);
    const seen: string[] = [];
    let land = () => {};
    play.at(0, () => {
      seen.push("swing");
      land = play.hold();
    });
    // Queued at the same moment as the swing: the health it costs, the line in the log.
    play.at(0, () => seen.push("health"));
    play.at(200, () => seen.push("falls"));
    advance(1000);
    expect(seen).toEqual(["swing"]);
    land();
    expect(seen).toEqual(["swing", "health"]);
    // The clock goes on from the landing, not from the swing.
    advance(199);
    expect(seen).toEqual(["swing", "health"]);
    advance(1);
    expect(seen).toEqual(["swing", "health", "falls"]);
  });

  it("skips a pause already spent waiting on the blow", () => {
    const { clock, advance } = handClock();
    const play = playback(clock);
    const seen: string[] = [];
    let land: (upTo?: number) => void = () => {};
    play.at(0, () => (land = play.hold()));
    play.at(280, () => seen.push("what came of it"));
    play.at(500, () => seen.push("next"));
    advance(600);
    land(280);
    expect(seen).toEqual(["what came of it"]);
    advance(219);
    expect(seen).toEqual(["what came of it"]);
    advance(1);
    expect(seen).toEqual(["what came of it", "next"]);
  });

  it("waits for every hold, and a release given twice counts once", () => {
    const { clock, advance } = handClock();
    const play = playback(clock);
    const seen: string[] = [];
    let a = () => {};
    let b = () => {};
    play.at(0, () => {
      a = play.hold();
      b = play.hold();
    });
    play.at(0, () => seen.push("after"));
    advance(0);
    a();
    a();
    expect(seen).toEqual([]);
    b();
    expect(seen).toEqual(["after"]);
  });

  it("does not wait for ever on a blow that never lands", () => {
    const { clock, advance } = handClock();
    const play = playback(clock, 500);
    const seen: string[] = [];
    play.at(0, () => void play.hold());
    play.at(0, () => seen.push("after"));
    advance(499);
    expect(seen).toEqual([]);
    advance(1);
    expect(seen).toEqual(["after"]);
  });

  it("goes on at once when a blow lands as it is struck", () => {
    const { clock, advance } = handClock();
    const play = playback(clock);
    const seen: string[] = [];
    play.at(0, () => play.hold()());
    play.at(0, () => seen.push("after"));
    advance(0);
    expect(seen).toEqual(["after"]);
  });

  it("shows nothing more once stopped, whether waiting on a time or a blow", () => {
    const { clock, advance } = handClock();
    const play = playback(clock);
    const seen: string[] = [];
    let land = () => {};
    play.at(0, () => (land = play.hold()));
    play.at(0, () => seen.push("held"));
    play.at(100, () => seen.push("later"));
    advance(0);
    play.stop();
    land();
    advance(5000);
    expect(seen).toEqual([]);
  });
});
