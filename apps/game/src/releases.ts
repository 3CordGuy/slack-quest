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

// ---------- what a newer build brings ----------
//
// A tab left open on an older build is told a newer one is out (client/NewVersion.tsx)
// and can list what it brings. The tab names the newest tagged release it knows when
// it asks /api/version; the Worker, which carries the newer build's list, answers
// with the releases after that one. So it is the same list the board shows, a build ahead.

/** The newest tagged release in a list: what a build names when it asks what is newer. Null when it lists none. */
export const newestTagged = (list: readonly Release[] = RELEASES): string | null => list.find((r) => !r.unreleased)?.id ?? null;

/**
 * The releases newer than the tagged release `since`, newest first: what a build
 * that old is missing. One that names no release, or one this build no longer
 * lists, is told only the newest, as the board marks only the newest as new.
 */
export function releasesSince(since: string | null | undefined, list: readonly Release[] = RELEASES): Release[] {
  const at = since ? list.findIndex((r) => r.id === since) : -1;
  return list.slice(0, at >= 0 ? at : 1);
}

/** A release list from another build's answer, with anything that is not a release left out. */
export function parseReleases(raw: unknown): Release[] {
  if (!Array.isArray(raw)) return [];
  const out: Release[] = [];
  for (const r of raw as Partial<Release>[]) {
    if (!r || typeof r.id !== "string" || !Array.isArray(r.notes)) continue;
    const notes = r.notes
      .filter((n) => !!n && typeof n.text === "string" && n.text !== "")
      .map((n) => ({ area: typeof n.area === "string" && n.area ? n.area : null, text: n.text }));
    out.push({ id: r.id, date: typeof r.date === "string" ? r.date : "", notes, ...(r.unreleased ? { unreleased: true } : {}) });
  }
  return out;
}

/**
 * Of the releases a newer build lists, what is news to this one. A staging build
 * already shows its untagged commits as "Coming next", and a later build lists
 * them again (there, or under the tag they went out in), so those lines are
 * dropped; a release left with nothing to say is dropped too.
 */
export function incomingNotes(newer: readonly Release[], mine: readonly Release[] = RELEASES): Release[] {
  const line = (n: ReleaseNote) => `${n.area ?? ""}\n${n.text}`;
  const have = new Set(mine.filter((r) => r.unreleased).flatMap((r) => r.notes.map(line)));
  return newer.map((r) => ({ ...r, notes: r.notes.filter((n) => !have.has(line(n))) })).filter((r) => r.notes.length > 0);
}

/** "13 November 2026 · update 9" for `game-v2026.11.13.9`; "Coming next" for untagged commits. */
export function releaseTitle(r: Release): string {
  if (r.unreleased) return "Coming next";
  const m = /^game-v(\d{4})\.(\d{1,2})\.(\d{1,2})(?:\.(\d+))?$/.exec(r.id);
  const day = m ? new Date(Date.UTC(+m[1], +m[2] - 1, +m[3])) : new Date(r.date);
  const when = day.toLocaleDateString("en-GB", { day: "numeric", month: "long", year: "numeric", timeZone: "UTC" });
  return m?.[4] ? `${when} · update ${m[4]}` : when;
}
