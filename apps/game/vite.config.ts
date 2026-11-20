import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { audioDev } from "./scripts/audio/dev-plugin.ts";
import { releaseNotes } from "./scripts/release-notes.ts";

// The Cloudflare plugin runs the Worker (src/worker.ts) and its Durable
// Object inside Miniflare next to the Vite dev server, so /api/* and the
// React app share an origin. Bindings come from wrangler.jsonc.
//
// The Worker's AI binding has no local stand-in: the plugin reaches Cloudflare
// for it, which needs a `wrangler login` that has not lapsed. `--mode offline`
// (the "game-offline" entry in .claude/launch.json) leaves that connection
// out, so the server starts without a login. Local dev answers with
// AI_MODE "mock" and never calls the binding; only a local run switched to
// live AI needs the connection.
/**
 * One id for this build, stamped into the client and the Worker alike (src/build.ts): the commit it was
 * built from and the moment it was built, so two builds of one commit still differ. A tab left open
 * compares its own against the deployed Worker's to notice it has gone stale.
 */
function buildId(): string {
  let commit = "nogit";
  try {
    commit = execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim() || commit;
  } catch {
    // Built outside a checkout: the time alone tells builds apart.
  }
  return `${commit}-${Date.now().toString(36)}`;
}
// Vite reads this config once for each half of the build (the client and the Worker). The id is made the
// first time and kept on the process, so both halves are stamped alike.
const BUILD = (process.env.GQ_BUILD_ID ??= buildId());

/** The file a module of a library is built into: three.js in one, React (with its scheduler) in another. Anything else: left to the bundler. */
function vendorChunk(id: string): string | undefined {
  const lib = /[\\/]node_modules[\\/](three|react|react-dom|scheduler)[\\/]/.exec(id)?.[1];
  return lib === undefined ? undefined : lib === "three" ? "three" : "react";
}

export default defineConfig(({ mode, command }) => ({
  // The dev server is always "dev" on both sides, so restarting it never looks like a new version.
  define: { __GQ_BUILD__: JSON.stringify(command === "serve" ? "dev" : BUILD) },
  // audioDev serves the WAV masters in ./audio while developing (see audio/README.md). The folder is
  // found from this file, not from where the server was started: started from the repo root (as the
  // .claude/launch.json entries do) it would otherwise look in the wrong place and find no masters,
  // and every placeholder (the battle music among them) would be silent.
  // releaseNotes reads the notice board's release notes out of git (see src/releases.ts).
  plugins: [react(), cloudflare({ remoteBindings: mode !== "offline" }), audioDev(fileURLToPath(new URL("./audio", import.meta.url))), releaseNotes()],
  // The two big libraries go in files of their own, apart from the game's code: their names carry a hash of what
  // is in them, so a release that only changes the game leaves them as they were and a returning player's browser
  // does not fetch them again. Only the browser's half of the build is split; the Worker stays one file.
  environments: { client: { build: { rollupOptions: { output: { manualChunks: vendorChunk } } } } },
  server: { port: 5180, strictPort: true },
}));
