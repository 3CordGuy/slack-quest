// Release notes: what changed in each tagged release of the game, shown on
// the Harbor's notice board.
//
// The notes are not written by hand or stored anywhere. scripts/release-notes.ts
// reads them out of git when the game is built (every `game-v*` tag is a
// release, and its notes are the commits since the tag before it), and a Vite
// plugin hands them to the client and the Worker as `virtual:release-notes`.
// Both halves come from the same build, so they always agree on the list.
//
// Which release a player last read is kept in D1 (players.seen_release); the
// notice board wears a "!" until they have read the newest one.

import { RELEASES as BUILT } from "virtual:release-notes";

export interface ReleaseNote {
  /** The part of the game it is about, from a commit subject like "Felling: …". Null when it names none. */
  area: string | null;
  text: string;
}

export interface Release {
  /** The tag (`game-v2026.11.13.9`), or `next-<sha>` for commits not yet tagged. */
  id: string;
  /** When it was cut: the tagged commit's date, ISO 8601. */
  date: string;
  notes: ReleaseNote[];
  /** The first tag of all: everything before it is the game itself, so it lists nothing. */
  first?: boolean;
  /** Commits since the last tag. Only in development and staging builds. */
  unreleased?: boolean;
}

/** Every release this build knows, newest first. */
export const RELEASES = BUILT as readonly Release[];

/** The newest release, if there is one. */
export const latestRelease = (list: readonly Release[] = RELEASES): Release | undefined => list[0];

/** True when there is a release newer than the one this player last read. */
export function hasUnseen(seen: string | null | undefined, list: readonly Release[] = RELEASES): boolean {
  const latest = latestRelease(list);
  return !!latest && latest.id !== seen;
}

/**
 * How many releases, from the top, are new to this player. A player who has
 * never read the board (or last read one this build no longer lists) has only
 * the newest marked, not the whole history.
 */
export function unseenCount(seen: string | null | undefined, list: readonly Release[] = RELEASES): number {
  if (list.length === 0) return 0;
  const at = seen ? list.findIndex((r) => r.id === seen) : -1;
  return at >= 0 ? at : 1;
}

/** "13 November 2026 · update 9" for `game-v2026.11.13.9`; "Coming next" for untagged commits. */
export function releaseTitle(r: Release): string {
  if (r.unreleased) return "Coming next";
  const m = /^game-v(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d+))?$/.exec(r.id);
  const day = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(r.date);
  const when = day.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return m?.[4] ? `${when} · update ${m[4]}` : when;
}
