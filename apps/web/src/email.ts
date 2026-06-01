// Outbound transactional email via MailChannels — the standard way to send
// from a Cloudflare Worker. No SDK; just a JSON POST to their relay.
//
// DNS / wrangler setup (one-time, ~15 min):
//   1. SPF record on your sending domain (e.g. teamgantt.dev):
//        TXT @ "v=spf1 a mx include:relay.mailchannels.net ~all"
//   2. domain_lockdown record so only your Workers can send from this
//      domain (prevents other CF accounts from spoofing you):
//        TXT _mailchannels "v=mc1 cfid=<your-cloudflare-account-id>"
//   3. (Recommended) DKIM keypair so messages aren't marked as spam:
//        - Generate: openssl genrsa 2048 | openssl rsa -pubout
//        - Publish public part as a TXT at <selector>._domainkey
//        - Add private key as a wrangler SECRET: DKIM_PRIVATE_KEY
//        - Set DKIM_DOMAIN + DKIM_SELECTOR in wrangler.jsonc vars
//
// Wrangler env vars expected (defaults work for dev):
//   MAIL_FROM_ADDRESS  e.g. "noreply@teamgantt.dev"
//   MAIL_FROM_NAME     e.g. "Gantt Quest"
//   DKIM_DOMAIN        the domain in MAIL_FROM_ADDRESS (omit to skip DKIM)
//   DKIM_SELECTOR      e.g. "mailchannels" (omit to skip DKIM)
//   DKIM_PRIVATE_KEY   PEM-formatted RSA private key (wrangler secret)

export interface SendEmailOpts {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface EmailEnv {
  ENVIRONMENT?: string;
  MAIL_FROM_ADDRESS?: string;
  MAIL_FROM_NAME?: string;
  DKIM_DOMAIN?: string;
  DKIM_SELECTOR?: string;
  DKIM_PRIVATE_KEY?: string;
}

/** Returns true on success. Logs failures but does not throw — callers
 *  typically still want to succeed (e.g. /auth/email/request) and let the
 *  user try again rather than 500. */
export async function sendEmail(env: EmailEnv, opts: SendEmailOpts): Promise<boolean> {
  // In local dev (no MailChannels DKIM setup), just log to console so the
  // developer can copy the code from wrangler logs instead of needing a
  // real email round-trip.
  if (env.ENVIRONMENT !== "production") {
    console.log(`[email/dev] to=${opts.to} subject=${opts.subject}\n${opts.text}`);
    return true;
  }

  const fromAddress = env.MAIL_FROM_ADDRESS ?? "noreply@example.invalid";
  const fromName = env.MAIL_FROM_NAME ?? "Gantt Quest";

  const personalizations: Array<Record<string, unknown>> = [{
    to: [{ email: opts.to }],
  }];

  // Attach DKIM info if configured. MailChannels signs the message before
  // relaying — receivers verify with the public key in your DNS.
  if (env.DKIM_DOMAIN && env.DKIM_SELECTOR && env.DKIM_PRIVATE_KEY) {
    personalizations[0].dkim_domain = env.DKIM_DOMAIN;
    personalizations[0].dkim_selector = env.DKIM_SELECTOR;
    personalizations[0].dkim_private_key = env.DKIM_PRIVATE_KEY;
  }

  const body = {
    personalizations,
    from: { email: fromAddress, name: fromName },
    subject: opts.subject,
    content: [
      { type: "text/plain", value: opts.text },
      ...(opts.html ? [{ type: "text/html", value: opts.html }] : []),
    ],
  };

  try {
    const res = await fetch("https://api.mailchannels.net/tx/v1/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "<no body>");
      console.error(`[email] MailChannels rejected: ${res.status} ${text}`);
      return false;
    }
    return true;
  } catch (e) {
    console.error(`[email] MailChannels send failed: ${(e as Error).message}`);
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
