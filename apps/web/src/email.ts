// Outbound transactional email via the native Cloudflare Email Sending
// binding (https://developers.cloudflare.com/email-service/get-started/send-emails/).
// No SDK, no API key — `env.EMAIL.send({to, from, subject, html, text})`.
//
// Domain setup (one-time, in the Cloudflare dashboard):
//   1. Email Service → Send Emails → Onboard Domain
//   2. Pick your domain (must already be on Cloudflare DNS)
//   3. Add records — Cloudflare auto-provisions MX/SPF/DKIM/DMARC on the
//      cf-bounce subdomain.
//   4. Wait for propagation (usually 5-15 min).
//
// Wrangler binding (apps/web/wrangler.jsonc):
//   "send_email": [{ "name": "EMAIL", "remote": true }]
//   "vars": { "MAIL_FROM_ADDRESS": "noreply@yourdomain.com" }
//
// Local dev: the binding is optional. When EMAIL is unbound (no `remote: true`
// connection or no domain onboarded), we fall back to console.log so the
// developer can copy the 6-digit code from wrangler logs.

export interface SendEmailOpts {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailEnv {
  EMAIL?: SendEmail;
  ENVIRONMENT?: string;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
}

/** Returns true on success. Logs failures but does not throw — callers
 *  typically still want to succeed (e.g. /auth/email/request) and let the
 *  user try again rather than 500. */
export async function sendEmail(env: EmailEnv, opts: SendEmailOpts): Promise<boolean> {
  // Local dev or unbound: log to console so the developer can copy the code
  // from wrangler dev output without needing a domain onboarded.
  if (!env.EMAIL || env.ENVIRONMENT !== "production") {
    console.log(`[email/dev] to=${opts.to} subject=${opts.subject}\n${opts.text}`);
    return true;
  }

  const fromAddress = env.MAIL_FROM_ADDRESS ?? "noreply@example.invalid";
  const fromName = env.MAIL_FROM_NAME ?? "Gantt Quest";

  try {
    await env.EMAIL.send({
      to: opts.to,
      from: { email: fromAddress, name: fromName },
      subject: opts.subject,
      text: opts.text,
      html: opts.html,
    });
    return true;
  } catch (e) {
    console.error(`[email] EMAIL.send failed: ${(e as Error).message}`);
    return false;
  }
}

/** Pretty wrapper that builds the standard "Your code is XXXXXX" email and
 *  sends it. Used by the /api/auth/email/request endpoint. */
export async function sendLoginCodeEmail(
  env: EmailEnv,
  to: string,
  code: string,
): Promise<boolean> {
  const subject = `Your Gantt Quest sign-in code: ${code}`;
  const text =
    `Your Gantt Quest sign-in code is ${code}\n` +
    `\n` +
    `Enter it on the sign-in screen within 15 minutes. If you didn't request this, you can safely ignore this email.\n`;
  const html =
    `<!doctype html><html><body style="font-family: -apple-system, system-ui, sans-serif; background:#0e0f12; color:#f5f5f5; padding:32px;">` +
    `<div style="max-width:420px; margin:auto; background:#12141a; border:1px solid #1f2937; border-radius:12px; padding:24px;">` +
    `<h1 style="font:24px/1.2 serif; color:#f5d56b; margin:0 0 12px;">Gantt Quest</h1>` +
    `<p style="margin:0 0 16px; color:#9aa0a6;">Your sign-in code:</p>` +
    `<div style="font:32px/1 monospace; letter-spacing:8px; color:#f5f5f5; padding:16px; background:#0e0f12; border:1px solid #1f2937; border-radius:8px; text-align:center;">${code}</div>` +
    `<p style="margin:16px 0 0; color:#9aa0a6; font-size:12px;">Enter it within 15 minutes. If you didn't request this, ignore the email.</p>` +
    `</div></body></html>`;
  return sendEmail(env, { to, subject, text, html });
}
