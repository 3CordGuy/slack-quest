// Signing in and out (as a guest, or with a code sent by email), and the
// check every route registered after it sits behind: a session cookie that
// names a player.

import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { attachEmail, consumeEmailCode, createGuest, createPlayerWithEmail, createSession, deleteSession, issueEmailCode, normalizeEmail, playerByEmail, playerForToken } from "../db";
import { sendSignInCode } from "../email";
import type { AppEnv, GameApp } from "./shared";

/**
 * Session cookie name. An optional profile (?p=2 or the x-gq-profile header)
 * gives each browser tab its own guest, which is how two players are tested
 * on one machine.
 */
function cookieName(c: Context<AppEnv>): string {
  const profile = (c.req.header("x-gq-profile") ?? c.req.query("p") ?? "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(profile) ? `gq_session_${profile}` : "gq_session";
}

function setSession(c: Context<AppEnv>, token: string) {
  setCookie(c, cookieName(c), token, { httpOnly: true, sameSite: "Lax", secure: new URL(c.req.url).protocol === "https:", path: "/", maxAge: 60 * 60 * 24 * 365 });
}

/** The routes anyone may call without being signed in. Registered before `signedInOnly`. */
export function signInRoutes(app: GameApp): void {
  app.post("/api/auth/guest", async (c) => {
    const { player, token } = await createGuest(c.env.DB, "Guest");
    setSession(c, token);
    return c.json({ player });
  });

  // ---------- email sign-in ----------

  // Send a six-digit code. The reply is the same whether or not the address has an account.
  app.post("/api/auth/email/request", async (c) => {
    const body = await c.req.json<{ email?: string }>().catch(() => ({}) as { email?: string });
    const email = normalizeEmail(body.email);
    if (!email) return c.json({ error: "That does not look like an email address." }, 400);
    const code = await issueEmailCode(c.env.DB, email);
    if (code === "wait") return c.json({ error: "A code was just sent. Give it half a minute before asking again." }, 429);
    if (!(await sendSignInCode(c.env, email, code))) return c.json({ error: "The email could not be sent. Try again shortly." }, 502);
    return c.json({ ok: true });
  });

  // Check the code, then either sign in to the account that owns the address,
  // or attach the address to the guest who asked, keeping everything they have.
  app.post("/api/auth/email/verify", async (c) => {
    const body = await c.req.json<{ email?: string; code?: string }>().catch(() => ({}) as { email?: string; code?: string });
    const email = normalizeEmail(body.email);
    const code = String(body.code ?? "").replace(/\D/g, "");
    if (!email || code.length !== 6) return c.json({ error: "Enter the six-digit code from the email." }, 400);
    if (!(await consumeEmailCode(c.env.DB, email, code))) return c.json({ error: "That code is wrong or has expired. Ask for a new one." }, 401);

    const token = getCookie(c, cookieName(c));
    const current = token ? await playerForToken(c.env.DB, token) : null;
    const owner = await playerByEmail(c.env.DB, email);

    if (owner) {
      if (current?.id === owner.id) return c.json({ outcome: "already" });
      // An account already has this address: switch to it. Whatever guest was here stays behind.
      if (token) await deleteSession(c.env.DB, token);
      setSession(c, await createSession(c.env.DB, owner.id));
      return c.json({ outcome: "signed_in" });
    }
    if (current && !current.email && (await attachEmail(c.env.DB, current.id, email))) return c.json({ outcome: "linked" });
    // No guest to keep (or it already has another address): start a fresh account for this one.
    const player = await createPlayerWithEmail(c.env.DB, email);
    if (token) await deleteSession(c.env.DB, token);
    setSession(c, await createSession(c.env.DB, player.id));
    return c.json({ outcome: "created" });
  });

  app.post("/api/auth/signout", async (c) => {
    const token = getCookie(c, cookieName(c));
    if (token) await deleteSession(c.env.DB, token);
    deleteCookie(c, cookieName(c), { path: "/" });
    return c.json({ ok: true });
  });
}

/** The sign-in check. Every route registered after this one answers only to a signed-in player, who is in `c.get("player")`. */
export function signedInOnly(app: GameApp): void {
  app.use("/api/*", async (c, next) => {
    if (c.req.path.startsWith("/api/auth/")) return next();
    const token = getCookie(c, cookieName(c));
    const player = token ? await playerForToken(c.env.DB, token) : null;
    if (!player) return c.json({ error: "not signed in" }, 401);
    c.set("player", player);
    return next();
  });
}
