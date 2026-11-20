// Shared by the hut tests: furnishings to place, without spelling out every field.

import type { Furnishing } from "../hut";

/**
 * Makes furnishings for a test, each with the next id from `first`: on the hex `at` (or in storage, for null),
 * facing 0 in the middle of it, with `more` on top.
 */
export function pieceMaker(first = 1) {
  let next = first;
  return (defId: string, at: { q: number; r: number } | null, more: Partial<Furnishing> = {}): Furnishing => ({
    id: next++, defId, label: defId, q: at?.q ?? null, r: at?.r ?? null, facing: 0, x: 0, z: 0, y: 0, angle: 0, onId: null, inId: null, ...more,
  });
}
