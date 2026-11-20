// The town's buildings are loaded with the game, not on walking into them.
//
// Each is made put away (WorldRenderer's `resting`), built, and drawn once
// unseen, so that walking in later has nothing to build, compile or send to
// the graphics card. That work is done while the opening screen is still up:
// the first view to be shown waits here until the buildings are ready.

/** Views made put away that are not ready yet. */
let loading = 0;
/** Whoever is making them has more to make. */
let staging = false;
/** performance.now() when the wait began. Nobody is kept waiting past LONGEST_MS, whatever has gone wrong. */
let since = 0;
const LONGEST_MS = 8000;

const begin = () => {
  if (!staging && loading === 0) since = performance.now();
};

/** More buildings are about to be made (true), or all of them have been (false). */
export function placesStaging(on: boolean) {
  if (on) begin();
  staging = on;
}

/** A view has been made put away, and has its building and priming still to do. */
export function placeLoading() {
  begin();
  loading++;
}

/** That view is ready (or gone, or wanted on the screen before it was). */
export function placeReady() {
  loading = Math.max(0, loading - 1);
}

/** Whether the opening screen should stay up a little longer: buildings are still being loaded behind it. */
export function placesLoading(): boolean {
  return (staging || loading > 0) && performance.now() - since < LONGEST_MS;
}
