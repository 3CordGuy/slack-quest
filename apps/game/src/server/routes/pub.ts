// The pub: the socket into its room, the menu, the leaderboard, the
// traveling salesman, the regulars and their errands, and a word with the
// barkeep.

import { PUB_BARKEEP, PUB_DEALER, PUB_MAX_TALK, PUB_MENU, dueIn, nextSalesmanVisit, salesman, salesmanVisitAt } from "@gantt-quest/world";
import { RELEASES } from "../../releases";
import { barkeepReply } from "../ai";
import { crewFor, getCharacter,orderAtPub, refreshHut } from "../db";
import { dropErrand, handInErrand, regularsView, takeErrand, tradeWithRegular } from "../errands";
import { announceXp } from "../harbor-xp";
import { enterPub } from "../pub-room";
import { pubLeaderboard } from "../pub-scores";
import { buyFromSalesman, getSalesman } from "../salesman";
import type { GameApp } from "./shared";

/** What the barkeep knows about traveling salesmen: who is in, or who is due next. */
function salesmanFact(crewId: string): string {
  const at = Date.now();
  const here = salesmanVisitAt(crewId, at);
  const who = (id: string) => salesman(id)!;
  if (here) return `A traveling salesman is in the pub now, in the corner by the far wall: ${who(here.salesmanId).name}, ${who(here.salesmanId).trade}. Gone ${dueIn(here.endsAt - at)}.`;
  const next = nextSalesmanVisit(crewId, at);
  return next
    ? `No traveling salesman is in. Word is ${who(next.salesmanId).name}, ${who(next.salesmanId).trade}, is due ${dueIn(next.startsAt - at)}.`
    : "No traveling salesman is in, and none is due that you know of.";
}

export function pubRoutes(app: GameApp): void {
  // ---------- the pub ----------

  app.get("/api/pub/ws", (c) => enterPub(c.env, c.get("player"), c.req.raw));

  // The crew's leaderboard for the pub's game tables, on the board on the back wall.
  app.get("/api/pub/leaderboard", async (c) => {
    const result = await pubLeaderboard(c.env.DB, c.get("player").id);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  // Order a meal off the menu. The price is the menu's. `rested` says whether it gave back a gathering outing.
  app.post("/api/pub/order", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ itemId?: unknown }>().catch(() => ({}) as { itemId?: unknown });
    const result = await orderAtPub(c.env.DB, player.id, String(body.itemId ?? ""));
    if (typeof result === "string") return c.json({ error: result }, 409);
    return c.json({ rested: result.rested });
  });

  // The traveling salesman in the pub, if one is in, and their stock as this player sees it; otherwise when the next is due.
  // `x-gq-salesman` forces a visitor in the dev server only (see server/salesman.ts).
  app.get("/api/pub/salesman", async (c) => {
    const result = await getSalesman(c.env.DB, c.get("player").id, c.req.header("x-gq-salesman"));
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  // Buy one entry of the salesman's stock. Only the index is named; the stock and its prices are derived here.
  app.post("/api/pub/salesman/buy", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ index?: unknown }>().catch(() => ({}) as { index?: unknown });
    const result = await buyFromSalesman(c.env.DB, player.id, body.index, c.req.header("x-gq-salesman"));
    if (typeof result === "string") return c.json({ error: result }, 409);
    // A blueprint or a furnishing shows up in their hut, if they have it open in another tab.
    if (result.got.goods.kind === "blueprint" || result.got.goods.kind === "furnishing") c.executionCtx.waitUntil(refreshHut(c.env, player.id));
    return c.json(result);
  });

  // The pub's regulars: who is in today, the job each has going, and where this player stands with each.
  app.get("/api/pub/regulars", async (c) => {
    const result = await regularsView(c.env.DB, c.get("player").id);
    return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
  });

  // Take on, hand in, trade or give up a regular's job. Only the regular is named; the terms are derived here.
  app.post("/api/pub/errand", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ regular?: unknown; action?: unknown }>().catch(() => ({}) as { regular?: unknown; action?: unknown });
    const db = c.env.DB;
    if (body.action === "accept") {
      const result = await takeErrand(db, player.id, body.regular);
      return typeof result === "string" ? c.json({ error: result }, 409) : c.json(result);
    }
    if (body.action === "drop") {
      const error = await dropErrand(db, player.id, body.regular);
      return error ? c.json({ error }, 409) : c.json({ ok: true });
    }
    if (body.action === "handin" || body.action === "trade") {
      const result = body.action === "handin" ? await handInErrand(db, player.id, body.regular) : await tradeWithRegular(db, player.id, body.regular);
      if (typeof result === "string") return c.json({ error: result }, 409);
      if (result.xp) c.executionCtx.waitUntil(announceXp(c.env, player.id, result.xp));
      return c.json(result);
    }
    return c.json({ error: "Accept, hand in, trade or drop." }, 400);
  });

  // A word with the barkeep. He only talks: nothing he says changes anything.
  app.post("/api/pub/talk", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ text?: unknown }>().catch(() => ({}) as { text?: unknown });
    const text = String(body.text ?? "").replace(/\s+/g, " ").trim().slice(0, PUB_MAX_TALK);
    if (!text) return c.json({ error: "Say something first." }, 400);
    const [character, crew] = await Promise.all([getCharacter(c.env.DB, player.id), crewFor(c.env.DB, player.id)]);
    if (character?.status !== "active" || !crew) return c.json({ error: "The pub is for crews." }, 409);
    // Everyone in the pub sees the exchange over the two heads; the conversation itself stays in the asker's panel.
    const room = c.env.PUB_ROOM.get(c.env.PUB_ROOM.idFromName(crew.id));
    const bubble = (id: string, line: string) => room.fetch("https://pub/bubble", { method: "POST", body: JSON.stringify({ id, text: line }) }).then(() => {}, () => {});
    c.executionCtx.waitUntil(bubble(player.id, text));
    const news = RELEASES.find((r) => !r.unreleased && r.notes.length > 0);
    const facts = [
      ...PUB_MENU.map((i) => `On the board: ${i.name}, ${i.price} gold. ${i.blurb}`),
      "The board is meals only: no drink is sold. A meal gives a hero back one gathering outing, once a day.",
      "There is a dice table in the pub where crewmates bluff each other for a small stake.",
      salesmanFact(crew.id),
      `${PUB_DEALER.name}, ${PUB_DEALER.trade}, leans on the pillar at the end of the bar and knows which regulars are in and what small jobs they have going. The Harbor's notice board outside is for news of the Harbor itself.`,
      ...(news ? news.notes.slice(0, 4).map((n) => `News pinned on the Harbor's notice board: ${n.area ? `${n.area}: ` : ""}${n.text}.`) : []),
    ];
    const say = await barkeepReply(c.env, { hero: character.name, crew: crew.name, text, facts });
    c.executionCtx.waitUntil(bubble(PUB_BARKEEP.id, say));
    return c.json({ say });
  });
}
