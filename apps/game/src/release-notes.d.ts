// The release notes the build reads out of git (see scripts/release-notes.ts).
// Typed as the Release list in src/releases.ts, which is the only importer.
declare module "virtual:release-notes" {
  export const RELEASES: unknown[];
}
