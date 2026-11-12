// Calls to the admin routes. The server checks the ADMIN_EMAILS allow-list
// on every one; a 403 here means this account is not on it.

import type { ContentBundle, HistoryRow, OverrideKind, OverrideRow, OverrideValue } from "../../server/content";
import { PROFILE } from "../api";

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: { "content-type": "application/json", ...(PROFILE ? { "x-gq-profile": PROFILE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw new Error(data.error ?? `Request failed (${res.status})`);
  return data as T;
}

const at = (kind: OverrideKind, target: string) => `/api/admin/overrides/${kind}/${encodeURIComponent(target)}`;

export const adminApi = {
  list: () => call<{ overrides: OverrideRow[] }>("GET", "/api/admin/overrides").then((r) => r.overrides),
  save: (kind: OverrideKind, target: string, value: OverrideValue) => call<{ version: number; value: OverrideValue }>("PUT", at(kind, target), { value }),
  revert: (kind: OverrideKind, target: string) => call<{ removed: boolean }>("DELETE", at(kind, target)),
  history: (kind: OverrideKind, target: string) => call<{ history: HistoryRow[] }>("GET", `${at(kind, target)}/history`).then((r) => r.history),
  exportAll: () => call<ContentBundle>("GET", "/api/admin/export"),
  importAll: (bundle: unknown) => call<{ version: number; imported: number }>("POST", "/api/admin/import", bundle),
};
