import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";

// `@cloudflare/vite-plugin` runs the Worker (src/worker.ts) inside Miniflare
// alongside the Vite dev server, so /api/* and the React app share an origin
// — no proxy, no second process. Configuration (bindings, assets directory,
// entry) is read from wrangler.jsonc.
//
// `vite build` produces:
//   dist/client/   ← static assets (referenced by wrangler.jsonc `assets.directory`)
//   dist/<worker>  ← bundled Worker (deployed by `wrangler deploy`)
export default defineConfig({
  plugins: [react(), cloudflare()],
});
