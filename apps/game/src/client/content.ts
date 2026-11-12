// The admin content overrides as this client sees them: one bundle loaded at
// start, before the first screen draws. The renderer and the UI read from
// here and fall back to the code defaults for anything not overridden.
//
// The server's ETag lets the browser revalidate cheaply on each load; the
// last good bundle is also kept in localStorage so a failed fetch still
// shows the overrides instead of the defaults.

import type { ContentBundle } from "../server/content";
import { PROFILE } from "./api";
import { applyArt } from "./art";

export type { ContentBundle };

const EMPTY: ContentBundle = { version: 0, names: {}, palettes: {}, icons: {}, sprites: {} };
const STORE_KEY = "gq_content";

let bundle: ContentBundle = EMPTY;
const listeners = new Set<(b: ContentBundle) => void>();

/** The overrides in force. Empty until loadContent has run. */
export function content(): ContentBundle {
  return bundle;
}

/** Replace the bundle in force, e.g. with an admin's unsaved draft for a preview. */
export function setContent(next: ContentBundle): void {
  bundle = next;
  for (const fn of listeners) fn(bundle);
}

/** Called whenever the bundle changes. Returns an unsubscribe. */
export function onContent(fn: (b: ContentBundle) => void): () => void {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

function stored(): ContentBundle | null {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    return raw ? (JSON.parse(raw) as ContentBundle) : null;
  } catch {
    return null;
  }
}

/**
 * Fetch the bundle. Never throws: on any failure the game carries on with
 * the last bundle this browser saw, or with the code defaults.
 */
export async function loadContent(): Promise<ContentBundle> {
  try {
    const res = await fetch("/api/content", { headers: PROFILE ? { "x-gq-profile": PROFILE } : {} });
    if (!res.ok) throw new Error(`content ${res.status}`);
    const next = (await res.json()) as ContentBundle;
    try {
      localStorage.setItem(STORE_KEY, JSON.stringify(next));
    } catch {
      // Storage full or blocked: the fetched bundle still applies for this visit.
    }
    setContent(next);
  } catch {
    setContent(stored() ?? EMPTY);
  }
  // Palettes and icons reach the renderers before anything is drawn.
  await applyArt(bundle).catch(() => undefined);
  return bundle;
}
