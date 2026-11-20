// Giving and trading between crewmates: the table opened, a side laid
// out, accepted and walked away from.

import { refreshHarbor } from "../db";
import { acceptTrade, announceTrade, closeTrade, listTrades, openTrade, setTradeSide } from "../trade";
import type { GameApp } from "./shared";

export function tradeRoutes(app: GameApp): void {
  // ---------- giving and trading between crewmates ----------

  // The trades this player has open, as they see them, and how recent ones ended.
  app.get("/api/trade", async (c) => c.json(await listTrades(c.env.DB, c.get("player").id)));

  // Open the trade table with one crewmate, or find the one already open between the two.
  app.post("/api/trade/open", async (c) => {
    const body = await c.req.json<{ to?: unknown }>().catch(() => ({}) as { to?: unknown });
    const result = await openTrade(c.env.DB, c.get("player").id, body.to);
    if ("error" in result) return c.json({ error: result.error }, 409);
    c.executionCtx.waitUntil(announceTrade(c.env, result.id, c.get("player").id));
    return c.json({ id: result.id });
  });

  // Lay out your side of the table: the gear, gold and materials you offer. Takes both acceptances back.
  app.post("/api/trade/offer", async (c) => {
    const body = await c.req.json<{ id?: unknown; side?: unknown }>().catch(() => ({}) as { id?: unknown; side?: unknown });
    const result = await setTradeSide(c.env.DB, c.get("player").id, Number(body.id), body.side);
    if ("error" in result) return c.json({ error: result.error }, 409);
    c.executionCtx.waitUntil(announceTrade(c.env, Number(body.id), c.get("player").id));
    return c.json({ rev: result.rev });
  });

  // Accept the table as it stood at `rev`, or (ok: false) take that back. When both have accepted,
  // everything on it changes hands in one batch, or nothing does.
  app.post("/api/trade/accept", async (c) => {
    const body = await c.req.json<{ id?: unknown; rev?: unknown; ok?: unknown }>().catch(() => ({}) as { id?: unknown; rev?: unknown; ok?: unknown });
    const result = await acceptTrade(c.env.DB, c.get("player").id, Number(body.id), Number(body.rev), body.ok !== false);
    // Even a refused acceptance can change the table for the other side (it fell through, or both acceptances were taken back).
    c.executionCtx.waitUntil(announceTrade(c.env, Number(body.id), c.get("player").id));
    if ("error" in result) return c.json({ error: result.error }, 409);
    if (result.settled) c.executionCtx.waitUntil(refreshHarbor(c.env, result.crewId));
    return c.json({ ok: true, settled: result.settled });
  });

  // Walk away from the table: the trade is cancelled.
  app.post("/api/trade/close", async (c) => {
    const body = await c.req.json<{ id?: unknown }>().catch(() => ({}) as { id?: unknown });
    const result = await closeTrade(c.env.DB, c.get("player").id, Number(body.id));
    if ("error" in result) return c.json({ error: result.error }, 409);
    c.executionCtx.waitUntil(announceTrade(c.env, Number(body.id), c.get("player").id));
    return c.json({ ok: true });
  });
}
