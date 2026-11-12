// Email sign-in. A guest account lives only in this browser's cookie; adding
// an email makes it durable and reachable from any device. The same two-step
// form (address, then the six-digit code that was mailed) serves a guest
// saving their progress and a returning player signing in.

import { useState } from "react";
import { api, type Me } from "./api";

type Outcome = "linked" | "signed_in" | "created" | "already";

const DONE: Record<Outcome, string> = {
  linked: "Saved. This character is now tied to your email.",
  signed_in: "Welcome back. You are signed in to your account.",
  created: "Account created.",
  already: "You are already signed in with that address.",
};

interface FormProps {
  /** Called after a successful sign-in, once the caller should reload the player. */
  onDone(): Promise<unknown>;
  /** The guest has a character that signing in to another account would leave behind. */
  hasCharacter: boolean;
}

export function EmailSignIn({ onDone, hasCharacter }: FormProps) {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<Outcome | null>(null);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const request = () =>
    run(async () => {
      await api.requestCode(email);
      setSent(true);
      setCode("");
    });
  const verify = () =>
    run(async () => {
      const { outcome } = await api.verifyCode(email, code);
      setDone(outcome);
      await onDone();
    });

  if (done) return <p className="good">{DONE[done]}</p>;
  return (
    <div className="signin">
      {error && <div className="banner error">{error}</div>}
      {!sent ? (
        <>
          <label className="field">
            <span>Email</span>
            <input type="email" autoComplete="email" inputMode="email" value={email} maxLength={254} placeholder="you@example.com" onChange={(e) => setEmail(e.target.value)} onKeyDown={(e) => e.key === "Enter" && email.includes("@") && void request()} />
          </label>
          <button className="primary" disabled={busy || !email.includes("@")} onClick={request}>Email me a code</button>
        </>
      ) : (
        <>
          <p className="muted">A six-digit code is on its way to <strong>{email}</strong>. It works for 15 minutes.</p>
          <label className="field">
            <span>Code</span>
            <input className="code-input" autoComplete="one-time-code" inputMode="numeric" value={code} maxLength={6} placeholder="000000" onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} onKeyDown={(e) => e.key === "Enter" && code.length === 6 && void verify()} />
          </label>
          <div className="row">
            <button className="primary" disabled={busy || code.length !== 6} onClick={verify}>Sign in</button>
            <button disabled={busy} onClick={() => { setSent(false); setError(null); }}>Use a different address</button>
          </div>
        </>
      )}
      {hasCharacter && (
        <p className="muted small-print">
          If that address has no account yet, this character is saved to it. If it already has one, you will be signed in to that account and this guest character is left behind.
        </p>
      )}
    </div>
  );
}

/** The account window in the Harbor: save a guest's progress, or see who is signed in and sign out. */
export function AccountPanel({ me, refresh, onClose }: { me: Me; refresh(): Promise<unknown>; onClose(): void }) {
  const [busy, setBusy] = useState(false);
  const signOut = async () => {
    if (!confirm("Sign out? You can sign back in with your email at any time.")) return;
    setBusy(true);
    await api.signOut().catch(() => undefined);
    // A fresh guest takes over this browser; the account waits for its owner.
    location.hash = "";
    location.reload();
  };
  return (
    <div className="overlay inv-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel account" role="dialog" aria-label="Account">
        <header className="inv-head">
          <h2>Account</h2>
          <span className="spacer" />
          <button onClick={onClose}>Close</button>
        </header>
        {me.player.email ? (
          <>
            <p>Signed in as <strong>{me.player.email}</strong>.</p>
            <p className="muted">Your character, gear and crew are saved to this address. Sign in with it on any device to pick up where you left off.</p>
            <button className="danger" disabled={busy} onClick={signOut}>Sign out</button>
          </>
        ) : (
          <>
            <p><strong>You are playing as a guest.</strong></p>
            <p className="muted">Right now this character exists only in this browser. Clear its cookies, or switch device, and it is gone. Add an email to keep it.</p>
            <EmailSignIn onDone={refresh} hasCharacter={me.character?.status === "active"} />
          </>
        )}
      </div>
    </div>
  );
}
