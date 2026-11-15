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
  // game-v2026.11.15.2 (#419)
  "a75dff4189c1bef9666dcc0c09affe79e3ad6f96": [
    "Heroes: choose how your hero looks: build, head, ears, hair, eyes, nose, mustache, beard, skin and hair colour",
    "Heroes: draw your own tattoos on a paper doll, in greys and muted colours",
    "Heroes: existing heroes get a look from their class; change it any time with Change look on your hero sheet",
    "Heroes: starting hat, tunic, trousers and shoes are items you can take off",
  ],
};
