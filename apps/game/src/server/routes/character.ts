// A hero: creating one (name, roll, confirm, re-roll), renaming and
// dressing them, spending what a level gives, and what they wear. Also the
// read-only sheet of anyone else's hero.

import { HERO_CLASSES, makeRng, parseAppearance, rollStartingStats } from "@gantt-quest/world";
import { heroName } from "../ai";
import {
  cleanHeroName,
  confirmCharacter,
  crewFor,
  deleteCharacter,
  equipItem,
  getCharacter,
  publicHero,
  refreshHarbor,
  renameCharacter,
  saveAppearance,
  saveDraft,
  setAbilitySlot,
  setGearHidden,
  spendPoint,
  unequipItem,
} from "../db";
import type { GameApp } from "./shared";

export function characterRoutes(app: GameApp): void {
  // A crewmate's hero sheet, read-only: what the overhead plate opens on a click.
  app.get("/api/hero/:id", async (c) => {
    const hero = await publicHero(c.env.DB, c.get("player").id, c.req.param("id"));
    if (!hero) return c.json({ error: "No such hero in your crew." }, 404);
    return c.json({ hero });
  });

  // Suggest a hero name for the class being created. Text only: nothing is saved.
  app.post("/api/character/name", async (c) => {
    const body = await c.req.json<{ classId?: string; avoid?: unknown }>().catch(() => ({}) as { classId?: string; avoid?: unknown });
    const cls = HERO_CLASSES.find((k) => k.id === body.classId);
    if (!cls) return c.json({ error: "Unknown class." }, 400);
    const avoid = Array.isArray(body.avoid) ? body.avoid.filter((a): a is string => typeof a === "string").map((a) => a.slice(0, 20)).slice(-12) : [];
    const playerId = c.get("player").id;
    // Another player's hero (draft or active) already has it; the asker's own draft does not count.
    const isTaken = async (name: string) =>
      !!(await c.env.DB.prepare("SELECT 1 FROM characters WHERE name = ?1 COLLATE NOCASE AND player_id != ?2 LIMIT 1").bind(name, playerId).first());
    return c.json({ name: await heroName(c.env, { className: cls.name, blurb: cls.blurb, avoid, isTaken }) });
  });

  // Roll (or re-roll) starting stats for a character that is still a draft.
  app.post("/api/character/roll", async (c) => {
    const player = c.get("player");
    const body = await c.req.json<{ classId?: string; name?: string }>().catch(() => ({}) as { classId?: string; name?: string });
    const name = cleanHeroName(body.name);
    if (!name) return c.json({ error: "Name must be 2 to 20 characters." }, 400);
    if (!HERO_CLASSES.some((k) => k.id === body.classId)) return c.json({ error: "Unknown class." }, 400);
    const existing = await getCharacter(c.env.DB, player.id);
    if (existing?.status === "active") return c.json({ error: "You already have a character." }, 409);
    const rng = makeRng(crypto.getRandomValues(new Uint32Array(1))[0]);
    await saveDraft(c.env.DB, player.id, name, body.classId!, rollStartingStats(rng, body.classId!));
    return c.json({ character: await getCharacter(c.env.DB, player.id) });
  });

  app.post("/api/character/confirm", async (c) => {
    const ok = await confirmCharacter(c.env.DB, c.get("player").id);
    return ok ? c.json({ ok }) : c.json({ error: "Nothing to confirm." }, 409);
  });

  // Discards the character and all its gear; the player starts creation again.
  app.post("/api/character/reroll", async (c) => {
    const player = c.get("player");
    await deleteCharacter(c.env.DB, player.id);
    // Their hut and roster entry disappear until the new character is confirmed.
    c.executionCtx.waitUntil(crewFor(c.env.DB, player.id).then((crew) => refreshHarbor(c.env, crew?.id ?? null)));
    return c.json({ ok: true });
  });

  // A new name for a confirmed hero, from their sheet. The client then has the rooms it is in re-read the hero (refresh).
  app.post("/api/character/rename", async (c) => {
    const body = await c.req.json<{ name?: unknown }>().catch(() => ({}) as { name?: unknown });
    const name = cleanHeroName(body.name);
    if (!name) return c.json({ error: "Name must be 2 to 20 characters." }, 400);
    const player = c.get("player");
    const problem = await renameCharacter(c.env.DB, player.id, name);
    if (problem) return c.json({ error: problem }, 409);
    // The crew's cards (the Harbor's notice board) show the new name to everyone there.
    c.executionCtx.waitUntil(crewFor(c.env.DB, player.id).then((crew) => refreshHarbor(c.env, crew?.id ?? null)));
    return c.json({ name });
  });

  // How the hero looks: body, face and colouring, from fixed presets (appearance.ts). Draft or active.
  app.post("/api/character/appearance", async (c) => {
    const body = await c.req.json<{ appearance?: unknown }>().catch(() => ({}) as { appearance?: unknown });
    if (!parseAppearance(body.appearance)) return c.json({ error: "That is not a look." }, 400);
    const ok = await saveAppearance(c.env.DB, c.get("player").id, body.appearance);
    return ok ? c.json({ ok }) : c.json({ error: "No character to dress." }, 409);
  });

  app.post("/api/character/spend", async (c) => {
    const body = await c.req.json<{ stat?: string }>().catch(() => ({}) as { stat?: string });
    const ok = await spendPoint(c.env.DB, c.get("player").id, String(body.stat));
    return ok ? c.json({ ok }) : c.json({ error: "No points to spend." }, 409);
  });

  app.post("/api/character/ability", async (c) => {
    const body = await c.req.json<{ slot?: unknown; ability?: unknown }>().catch(() => ({}) as { slot?: unknown; ability?: unknown });
    // A string puts that ability in the slot; null (and only null) empties it.
    if (body.ability !== null && typeof body.ability !== "string") return c.json({ error: "Which ability?" }, 400);
    const error = await setAbilitySlot(c.env.DB, c.get("player").id, Number(body.slot), body.ability);
    return error ? c.json({ error }, 409) : c.json({ ok: true });
  });

  app.post("/api/character/equip", async (c) => {
    const body = await c.req.json<{ itemId?: number }>().catch(() => ({}) as { itemId?: number });
    const error = await equipItem(c.env.DB, c.get("player").id, Number(body.itemId));
    return error ? c.json({ error }, 409) : c.json({ ok: true });
  });

  app.post("/api/character/unequip", async (c) => {
    const body = await c.req.json<{ itemId?: number }>().catch(() => ({}) as { itemId?: number });
    const error = await unequipItem(c.env.DB, c.get("player").id, Number(body.itemId));
    return error ? c.json({ error }, 409) : c.json({ ok: true });
  });

  app.post("/api/character/hide", async (c) => {
    const body = await c.req.json<{ itemId?: number; hidden?: boolean }>().catch(() => ({}) as { itemId?: number; hidden?: boolean });
    const error = await setGearHidden(c.env.DB, c.get("player").id, Number(body.itemId), body.hidden === true);
    return error ? c.json({ error }, 409) : c.json({ ok: true });
  });
}
