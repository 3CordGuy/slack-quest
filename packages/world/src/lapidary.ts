// The Lapidary: the shop in town where everything to do with gems and
// lodestones is done, by its keeper (keepers.ts has her and her room).
//
//   lodestones  cut plain from stone and iron (lodestone.ts), and worked at
//               her bench: fused, attuned, tempered, rerolled (stonecraft.ts).
//   gems        bought from whoever brings them, for gold. They are also what
//               tempering a lodestone takes, and attuning one to a boon.
//
// Unlike the smithy, the apothecary and the galley it is not a crew project:
// it stands from a crew's first day, since nobody goes out on the atlas
// without a lodestone. Nothing here is haggled over.

import type { Resources } from "./hut";

/**
 * What the lapidary pays for a gem. They are rare (a good thirty seconds at the quarry's face finds one or two,
 * a poor one none; an oyster or a fallen construct gives one now and then), so one is worth a few herbs' worth
 * more than a meal: selling the gems from a lucky day's outings buys a pub meal or two.
 */
export const GEM_PRICE = 12;

/** Why `qty` gems cannot be sold to the lapidary by someone holding `have`, or null if they can. */
export function sellGemsProblem(qty: unknown, have: Resources): string | null {
  if (typeof qty !== "number" || !Number.isSafeInteger(qty) || qty < 1) return "Sell at least one.";
  const held = have.gem ?? 0;
  if (held < qty) return held === 0 ? "You have no gems." : `You only have ${held} ${held === 1 ? "gem" : "gems"}.`;
  return null;
}
