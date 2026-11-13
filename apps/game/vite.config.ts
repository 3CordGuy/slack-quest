import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { cloudflare } from "@cloudflare/vite-plugin";
import { audioDev } from "./scripts/audio/dev-plugin.ts";

// The Cloudflare plugin runs the Worker (src/worker.ts) and its Durable
// Object inside Miniflare next to the Vite dev server, so /api/* and the
// React app share an origin. Bindings come from wrangler.jsonc.
export default defineConfig({
  // audioDev serves the WAV masters in ./audio while developing (see audio/README.md).
  plugins: [react(), cloudflare(), audioDev("./audio")],
  server: { port: 5180, strictPort: true },
});
