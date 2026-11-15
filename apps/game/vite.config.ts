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
export default defineConfig(({ mode }) => ({
  // audioDev serves the WAV masters in ./audio while developing (see audio/README.md). The folder is
  // found from this file, not from where the server was started: started from the repo root (as the
  // .claude/launch.json entries do) it would otherwise look in the wrong place and find no masters,
  // and every placeholder (the battle music among them) would be silent.
  // releaseNotes reads the notice board's release notes out of git (see src/releases.ts).
  plugins: [react(), cloudflare({ remoteBindings: mode !== "offline" }), audioDev(fileURLToPath(new URL("./audio", import.meta.url))), releaseNotes()],
  server: { port: 5180, strictPort: true },
}));
