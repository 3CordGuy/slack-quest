// Which way heroes are looking, carried between the place's connection and
// its view. A hero standing idle faces wherever their player's pointer is on
// the ground; this is how everyone else gets to see that too. The view says
// which way your own hero has turned (`look`), the connection sends it; the
// connection hears which way someone else has turned (`looked`), the view
// turns them. Neither needs to know the other: the Harbor, the pub and a hut
// each have a connection of their own, and one view at a time.

type Fn<A extends unknown[]> = (...args: A) => void;

function channel<A extends unknown[]>() {
  const heard = new Set<Fn<A>>();
  return {
    tell: (...args: A) => {
      for (const fn of heard) fn(...args);
    },
    /** Returns the way to stop listening. */
    hear: (fn: Fn<A>) => {
      heard.add(fn);
      return () => void heard.delete(fn);
    },
  };
}

const mine = channel<[step: number]>();
const theirs = channel<[id: string, step: number]>();

export const gaze = {
  /** Your own hero has turned to face a new way: a step round the compass (see LOOK_STEPS). */
  look: mine.tell,
  onLook: mine.hear,
  /** Someone else here has. */
  looked: theirs.tell,
  onLooked: theirs.hear,
};
