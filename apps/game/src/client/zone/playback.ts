// Playing out what happened in a fight: each thing is shown at its time on a clock that stops while a blow
// is on its way. A swing, a shot or a spell takes as long as the figure and the effect take to get there,
// which only the renderer knows; so whatever comes of it (the health on the bars, the line in the log, the
// roll's card, whoever falls, and everything after) waits for the blow to land, and not for a guess at it.

/** The clock and timers a playback runs on: the page's, or a test's. */
export type PlaybackClock = {
  now(): number;
  set(run: () => void, ms: number): unknown;
  clear(handle: unknown): void;
};

const PAGE: PlaybackClock = {
  now: () => performance.now(),
  set: (run, ms) => setTimeout(run, ms),
  clear: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** The longest one hold stops the clock for: a blow that never lands (a hidden tab draws nothing) is not waited on for ever. */
export const HOLD_MAX_MS = 2500;

export type Playback = {
  /** Run `run` once the clock reaches `at` ms. Times are asked for in order (never earlier than the last). */
  at(at: number, run: () => void): void;
  /**
   * Stop the clock until the function returned is called (once is enough; later calls do nothing). Called with
   * `upTo`, the clock also jumps ahead to that time if it is short of it: a pause already spent waiting is not waited again.
   */
  hold(): (upTo?: number) => void;
  /** Everything not yet shown is dropped. */
  stop(): void;
};

export function playback(clock: PlaybackClock = PAGE, holdMax = HOLD_MAX_MS): Playback {
  const queue: { at: number; run: () => void }[] = [];
  let next = 0;
  /** How far the clock has got, in ms, as of `since` (real time). */
  let reached = 0;
  let since = clock.now();
  let holds = 0;
  let running = false;
  let stopped = false;
  let timer: unknown = null;

  const tick = () => {
    if (holds === 0) reached += clock.now() - since;
    since = clock.now();
  };
  const pump = () => {
    if (timer !== null) clock.clear(timer);
    timer = null;
    if (stopped || running) return;
    running = true;
    tick();
    // One at a time: any of them may stop the clock, and what comes after it waits.
    while (holds === 0 && !stopped && next < queue.length && queue[next].at <= reached) queue[next++].run();
    running = false;
    if (holds === 0 && !stopped && next < queue.length) timer = clock.set(pump, queue[next].at - reached);
  };

  return {
    at(at, run) {
      queue.push({ at, run });
      // Never run there and then, even at 0: only the first waiting thing has a timer, and the rest are reached in turn.
      if (next === queue.length - 1 && !running && holds === 0 && !stopped && timer === null) timer = clock.set(pump, 0);
    },
    hold() {
      if (stopped) return () => {};
      tick();
      holds++;
      let done = false;
      const release = (upTo?: number) => {
        if (done) return;
        done = true;
        clock.clear(limit);
        tick();
        if (upTo !== undefined) reached = Math.max(reached, upTo);
        holds--;
        if (holds === 0) pump();
      };
      const limit = clock.set(() => release(), holdMax);
      return release;
    },
    stop() {
      stopped = true;
      if (timer !== null) clock.clear(timer);
      timer = null;
    },
  };
}
