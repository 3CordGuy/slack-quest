// Content overrides: the bundle every client loads at start, and the
// admin routes that change it (server/content.ts).

import { checkImport, checkOverride, contentBundle, contentVersion, deleteOverride, isAdmin, isOverrideKind, listOverrides, overrideHistory, putOverride, putOverrides, recentLog, type OverrideKind } from "../content";
import type { GameApp } from "./shared";

export function contentRoutes(app: GameApp): void {
  // ---------- content overrides ----------

  // Names, palettes and pixel art changed on the admin side, as one bundle every
  // client loads at start. The ETag is the bundle's version, so a reload with
  // nothing new costs one small 304.
  app.get("/api/content", async (c) => {
    // A client that names the bundle it has is answered from the version alone when that is still the one:
    // the overrides are only read for a client that needs them.
    const has = c.req.header("If-None-Match");
    if (has !== undefined && has === `"content-${await contentVersion(c.env.DB)}"`) {
      c.header("ETag", has);
      c.header("Cache-Control", "no-cache");
      return c.body(null, 304);
    }
    const bundle = await contentBundle(c.env.DB);
    const etag = `"content-${bundle.version}"`;
    c.header("ETag", etag);
    c.header("Cache-Control", "no-cache");
    if (c.req.header("If-None-Match") === etag) return c.body(null, 304);
    return c.json(bundle);
  });

  // Every admin route: signed in (above) and on the ADMIN_EMAILS allow-list.
  app.use("/api/admin/*", async (c, next) => {
    if (!isAdmin(c.env, c.get("player"))) return c.json({ error: "admins only" }, 403);
    return next();
  });

  app.get("/api/admin/overrides", async (c) => c.json({ overrides: await listOverrides(c.env.DB) }));

  app.put("/api/admin/overrides/:kind/:target", async (c) => {
    const { kind, target } = c.req.param();
    const body = await c.req.json<{ value?: unknown }>().catch(() => null);
    const checked = checkOverride(kind, target, body?.value);
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const version = await putOverride(c.env.DB, kind as OverrideKind, target, checked.value, c.get("player").id);
    return c.json({ version, value: checked.value });
  });

  app.delete("/api/admin/overrides/:kind/:target", async (c) => {
    const { kind, target } = c.req.param();
    if (!isOverrideKind(kind)) return c.json({ error: `Unknown override kind "${kind}".` }, 400);
    const removed = await deleteOverride(c.env.DB, kind, target, c.get("player").id);
    return c.json({ removed });
  });

  app.get("/api/admin/overrides/:kind/:target/history", async (c) => {
    const { kind, target } = c.req.param();
    if (!isOverrideKind(kind)) return c.json({ error: `Unknown override kind "${kind}".` }, 400);
    return c.json({ history: await overrideHistory(c.env.DB, kind, target) });
  });

  // Every change of every kind, newest first. `before` pages back by log id.
  app.get("/api/admin/log", async (c) => {
    const before = Number(c.req.query("before"));
    return c.json({ log: await recentLog(c.env.DB, 100, Number.isInteger(before) && before > 0 ? before : undefined) });
  });

  // Export is the bundle itself; import takes one back (from another environment) and checks every entry first.
  app.get("/api/admin/export", async (c) => {
    c.header("Content-Disposition", 'attachment; filename="gantt-quest-content.json"');
    return c.json(await contentBundle(c.env.DB));
  });

  app.post("/api/admin/import", async (c) => {
    const checked = checkImport(await c.req.json().catch(() => null));
    if (!checked.ok) return c.json({ error: checked.error }, 400);
    const version = await putOverrides(c.env.DB, checked.items, c.get("player").id);
    return c.json({ version, imported: checked.items.length });
  });
}
