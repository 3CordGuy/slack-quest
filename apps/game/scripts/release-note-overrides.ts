// Release notes for commits already merged, where the subject (or a missing
// Release-note trailer) did not say it well. Keyed by full commit hash; the
// value is the lines to show instead, each read like a subject
// ("Area: text"). An empty list leaves the commit out.
//
// For new work, write the subject or a Release-note: trailer instead (see
// release-notes.ts); this list is only for the past.

export const OVERRIDES: Record<string, string[]> = {
  // game-v2026.11.13.5 (#368)
  "2300bc847429c6de0e4bf348de67e8bf55f829b2": ["Sign-in: send http visits to https so returning players can sign in"],
};
