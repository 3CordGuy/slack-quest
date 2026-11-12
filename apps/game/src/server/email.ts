// Sign-in codes by email, through the Cloudflare Email Sending binding
// (developers.cloudflare.com/email-service/get-started/send-emails/).
//
// Sending needs two things in wrangler.jsonc: a `send_email` binding named
// EMAIL and a MAIL_FROM_ADDRESS var on a domain onboarded for sending. When
// either is missing (local development) the code is written to the server
// log instead, so the flow can be exercised without a mail domain.

import type { Env } from "./db";

/** Returns true if the message was handed to the mail service, or logged in development. */
export async function sendSignInCode(env: Env, to: string, code: string): Promise<boolean> {
  const subject = `Your Gantt Quest sign-in code: ${code}`;
  const text =
    `Your Gantt Quest sign-in code is ${code}\n\n` +
    "Enter it on the sign-in screen within 15 minutes. If you did not ask for this, you can ignore this email.\n";
  if (!env.EMAIL || !env.MAIL_FROM_ADDRESS) {
    console.log(`[email/dev] to=${to} ${text.split("\n")[0]}`);
    return true;
  }
  const html =
    '<!doctype html><html><body style="font-family: ui-monospace, Menlo, monospace; background:#23304f; color:#f1eee4; padding:32px;">' +
    '<div style="max-width:420px; margin:auto; background:#1b1830; border:2px solid #4a4570; padding:24px;">' +
    '<h1 style="font-size:22px; color:#ffd23f; margin:0 0 12px;">Gantt Quest</h1>' +
    '<p style="margin:0 0 16px; color:#a9a4c4;">Your sign-in code:</p>' +
    `<div style="font-size:32px; letter-spacing:8px; padding:16px; background:#14122a; border:2px solid #4a4570; text-align:center;">${code}</div>` +
    '<p style="margin:16px 0 0; color:#a9a4c4; font-size:12px;">Enter it within 15 minutes. If you did not ask for this, ignore this email.</p>' +
    "</div></body></html>";
  try {
    await env.EMAIL.send({ to, from: { email: env.MAIL_FROM_ADDRESS, name: env.MAIL_FROM_NAME ?? "Gantt Quest" }, subject, text, html });
    return true;
  } catch (err) {
    console.error("email:send-failed", { err: err instanceof Error ? err.message : String(err) });
    return false;
  }
}
