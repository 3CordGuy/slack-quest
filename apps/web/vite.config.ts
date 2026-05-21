import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { readFileSync } from "fs";

// `@cloudflare/vite-plugin` runs the Worker (src/worker.ts) inside Miniflare
// alongside the Vite dev server, so /api/* and the React app share an origin
// — no proxy, no second process. Configuration (bindings, assets directory,
// entry) is read from wrangler.jsonc.
//
// `vite build` produces:
//   dist/client/   ← static assets (referenced by wrangler.jsonc `assets.directory`)
//   dist/<worker>  ← bundled Worker (deployed by `wrangler deploy`)

// Read local dev overrides from .dev.vars (same file the worker runtime uses).
// Supports REMOTE_BINDINGS=false to disable remote bindings in dev mode
// independently of ENVIRONMENT, so the two concerns can be toggled separately.
function parseDevVars(): Record<string, string> {
  try {
    return Object.fromEntries(
      readFileSync(".dev.vars", "utf-8")
        .split("\n")
        .filter((l) => l.trim() && !l.startsWith("#") && l.includes("="))
        .map((l) => l.split("=").map((s) => s.trim()) as [string, string]),
    );
  } catch {
    return {};
  }
}

const devVars = parseDevVars();
const remoteBindings = devVars.REMOTE_BINDINGS !== "false";

export default defineConfig({
  plugins: [react(), cloudflare({ remoteBindings })],
});
