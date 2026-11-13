import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Separate from vite.config.ts so the Cloudflare plugin is not loaded in tests.
// The Durable Object base class comes from a small stand-in, so a room's
// message handling can be tested with fake sockets.
export default defineConfig({
  resolve: { alias: { "cloudflare:workers": fileURLToPath(new URL("./test/cloudflareWorkers.ts", import.meta.url)) } },
  test: {},
});
