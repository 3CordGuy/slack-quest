// When an answer about gathering means the pack has changed.
//
// The sea bag, the purse and the Harbor XP all come from one read of the hero
// (`/api/me`), taken when the page loads and again whenever something says it
// has changed. An outing that ends is paid into the pack on the server, in the
// same batch that closes it, so the answer that closes it has to say so here
// too. Otherwise the bag goes on showing what it held before the outing, and
// the stone, wood or gold only turns up after a reload.

/**
 * Whether this answer says an outing has just ended and been paid: by the
 * step that closed it (`paid`), or by a fishing sitting left alone too long
 * and closed the next time anyone looked (`sitting`). Either way the hero has
 * to be read again.
 */
export const outingPaid = (answer: { paid?: unknown; sitting?: unknown }): boolean => answer.paid != null || answer.sitting != null;
