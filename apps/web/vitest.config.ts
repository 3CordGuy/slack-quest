import { defineConfig } from "vitest/config";

// Separate vitest config so the Cloudflare Vite plugin (vite.config.ts) is
// not loaded during test runs — it throws on startup outside of a Worker env.
export default defineConfig({
  test: {},
});
