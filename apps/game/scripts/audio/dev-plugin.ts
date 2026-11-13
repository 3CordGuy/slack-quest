// While developing, serve the WAV masters in apps/game/audio as they are, so
// a bounce is heard without encoding anything:
//
//   /__audio/index.json    every master, its length and loop markers
//   /__audio/files/<key>   the file itself
//
// and tell the page when one is added, changed or removed, so a playing loop
// picks up the new take. Not part of a build: what ships is public/audio.

import { createReadStream, statSync } from "node:fs";
import { resolve, sep } from "node:path";
import type { Plugin } from "vite";
import type { AudioIndex } from "../../src/client/audio/types.ts";
import { describe, listWavs, readWav } from "./wav.ts";

export function audioDev(dir: string): Plugin {
  const root = resolve(dir);
  return {
    name: "gq-audio-dev",
    apply: "serve",
    configureServer(server) {
      server.watcher.add(root);
      let timer: ReturnType<typeof setTimeout> | undefined;
      const changed = (path: string) => {
        if (!resolve(path).startsWith(root + sep) || !/\.wav$/i.test(path)) return;
        // A DAW writes a bounce in pieces; wait for it to settle.
        clearTimeout(timer);
        timer = setTimeout(() => server.ws.send({ type: "custom", event: "gq:audio-changed" }), 300);
      };
      server.watcher.on("add", changed).on("change", changed).on("unlink", changed);

      server.middlewares.use("/__audio", (req, res, next) => {
        const path = decodeURIComponent((req.url ?? "").split("?")[0]);
        if (path === "/index.json") {
          const index: AudioIndex = { version: 1, files: {} };
          for (const [key, file] of listWavs(root)) {
            const info = readWav(file);
            if (!info) continue;
            // The modified time in the URL makes a changed file a new one to the page.
            const stamp = Math.round(statSync(file).mtimeMs);
            index.files[key] = { urls: { wav: `/__audio/files/${key.split("/").map(encodeURIComponent).join("/")}.wav?v=${stamp}` }, ...describe(info) };
          }
          res.setHeader("content-type", "application/json");
          res.setHeader("cache-control", "no-store");
          res.end(JSON.stringify(index));
          return;
        }
        if (path.startsWith("/files/")) {
          const file = resolve(root, "." + path.slice("/files".length));
          if (!file.startsWith(root + sep) || !/\.wav$/i.test(file)) return next();
          try {
            res.setHeader("content-length", statSync(file).size);
          } catch {
            res.statusCode = 404;
            res.end();
            return;
          }
          res.setHeader("content-type", "audio/wav");
          res.setHeader("cache-control", "no-store");
          createReadStream(file).pipe(res);
          return;
        }
        next();
      });
    },
  };
}
