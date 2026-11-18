// Gear put on or taken off in the sea bag, shown before the server has answered.
//
// The server decides what is worn (server/db.ts equipItem and unequipItem). Its answer, and the
// reading of the pack that follows it, take two round trips, and until they were back the bag showed
// nothing: a piece dragged onto the figure sprang back into the pack first. So the bag shows the
// change at the click, by the server's own rule, and keeps a list of the changes still on their way.
// `wornAhead` lays that list over the pack as the server last told it. When a change is answered it
// comes off the list: by then the pack has been read again and says the same thing, or the server
// refused, the pack was not read again, and the piece is back where it was.
//
// Only what the bag already knows the server allows is ever shown this way: it runs equipProblem
// (packages/world) before it sends anything.
//
// The hero drawn in the world is told what they wear by the room they stand in, which hears of a
// change later still. `lookToDraw` says what to draw for your own hero meanwhile: what the bag
// shows, until the room says the same or has had long enough to.

import { outfitKey, type Outfit } from "@gantt-quest/world";

/** One change of gear on its way to the server: this piece put on, or taken off. */
export interface WearChange {
  /** Which send it belongs to: it comes off the list when that send is answered. */
  op: number;
  itemId: number;
  on: boolean;
}

/** A row of the pack, as far as wearing it goes. */
interface Wearable {
  id: number;
  slot: string;
  equipped: number;
  hidden?: number;
}

/**
 * The pack as it will be once these changes are made, in order. Putting a piece on takes off whatever else
 * is in its slot; anything put on or taken off is no longer hidden. A change for a piece that is not in the
 * pack does nothing. The same list comes back when there is nothing to change.
 */
export function wornAhead<T extends Wearable>(inventory: T[], changes: readonly WearChange[]): T[] {
  let out = inventory;
  for (const change of changes) {
    const item = out.find((i) => i.id === change.itemId);
    if (!item) continue;
    out = out.map((i) => {
      if (i.id === item.id) return { ...i, equipped: change.on ? 1 : 0, hidden: 0 };
      return change.on && i.slot === item.slot && i.equipped ? { ...i, equipped: 0, hidden: 0 } : i;
    });
  }
  return out;
}

/** How long, after the server has answered every change, the bag's look is still drawn if the room has not told the same one. */
export const LOOK_HOLD_MS = 4000;

/** Your own hero's look as the bag shows it, and when the server had answered every change that made it (null: some are still on their way). */
export interface LookAhead {
  shown: Outfit;
  settledAt: number | null;
  /** The look the room was telling when this one was first shown (its outfitKey). */
  toldThen: string;
}

/**
 * What to draw for your own hero, given what the room tells (`told`) and what the bag shows. While changes
 * are on their way it is the bag's. Once they are answered it is still the bag's until the room has caught
 * up: it tells the same look, having told a different one before, or it has had LOOK_HOLD_MS to. (Telling
 * the same look as it did when the change was first shown is not catching up: after a piece is swapped and
 * swapped straight back the room is still to tell both.) `over` says the bag's look is done with.
 */
export function lookToDraw(ahead: LookAhead | null, told: Outfit | undefined, now: number): { outfit: Outfit | undefined; over: boolean } {
  if (!ahead) return { outfit: told, over: false };
  if (ahead.settledAt === null) return { outfit: ahead.shown, over: false };
  const key = outfitKey(told);
  const caughtUp = key === outfitKey(ahead.shown) && key !== ahead.toldThen;
  if (caughtUp || now - ahead.settledAt >= LOOK_HOLD_MS) return { outfit: told, over: true };
  return { outfit: ahead.shown, over: false };
}
