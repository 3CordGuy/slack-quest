// The Catch Book: a page per water, a slot per kind, filled by catching one.
// Finishing a page earns a wall piece and some XP; finishing the book (every
// page but the bonus) earns a title. Old Ironjaw is a bonus slot, outside the
// count, with his own reward. And the crew's records hang in the pub.

import { BOOK_PAGES, FISH, bookPage, type BookPage } from "./fishcatalog";

/** What finishing each page gives: a wall piece for home. The bonus page's is Old Ironjaw's jaw, for landing him. */
export const PAGE_REWARD: Record<BookPage, string> = {
  shallows: "shallows_chart",
  mouth: "brass_spyglass",
  deep: "lamp_lens",
  sea: "crossed_oars",
  strays: "lobster_pot",
  flotsam: "glass_floats",
  bonus: "ironjaw_jaw",
};
/** XP for finishing a page (or landing Old Ironjaw), outside the daily Harbor cap. */
export const PAGE_XP = 5;
/** The title for a full book. */
export const BOOK_TITLE = "Harbormaster's Angler";
/** Record fish the pub's wall holds. */
export const PUB_MOUNT_SLOTS = 8;

/** The pages that count towards a full book. */
export const COUNTED_PAGES = BOOK_PAGES.filter((p) => p !== "bonus");

export interface PageProgress {
  page: BookPage;
  have: number;
  of: number;
  done: boolean;
}

/** How far through each page a player is, from the kinds they have caught. */
export function bookProgress(caught: ReadonlySet<string>): PageProgress[] {
  return BOOK_PAGES.map((page) => {
    const slots = bookPage(page);
    const have = slots.filter((f) => caught.has(f.id)).length;
    return { page, have, of: slots.length, done: have === slots.length };
  });
}

/** Whether every counted page is done. */
export const bookFull = (caught: ReadonlySet<string>): boolean => bookProgress(caught).every((p) => p.page === "bonus" || p.done);

/**
 * What a sitting's catches finished: pages done now that were not before
 * (the bonus page with them, if Old Ironjaw was landed), and whether the book
 * was just filled.
 */
export function bookRewards(before: ReadonlySet<string>, after: ReadonlySet<string>): { pages: BookPage[]; full: boolean } {
  const was = new Map(bookProgress(before).map((p) => [p.page, p.done]));
  const pages = bookProgress(after).filter((p) => p.done && !was.get(p.page)).map((p) => p.page);
  return { pages, full: bookFull(after) && !bookFull(before) };
}

/** Where a kind bites, as a hint on its slot before it has been caught. */
export function biteHint(species: string): string {
  const f = FISH[species];
  if (!f) return "";
  if (f.kind === "haul") return "Comes up anywhere.";
  if (f.water.includes("sea")) return "Only out past the Harbor, by boat.";
  const where = f.water.map((w) => (w === "shallows" ? "off the west pier or the shore" : w === "mouth" ? "off the middle pier" : "off the east pier"));
  const far = f.rarity === "rare" || f.rarity === "legendary" ? ", far out" : "";
  return `Bites ${where.join(" or ")}${far}.`;
}
