// HTTP helpers for the Harbor screens.

import type { StatKey } from "@gantt-quest/core";

/** Optional ?p=2 gives this tab its own guest session, for testing two players on one machine. */
export const PROFILE = new URLSearchParams(location.search).get("p") ?? "";

export interface Character {
  name: string;
  class_id: string;
  status: "draft" | "active";
  level: number;
  xp: number;
  str: number;
  int_stat: number;
  vit: number;
  agi: number;
  dex: number;
  unspent_points: number;
  gold: number;
}

export interface InventoryItem {
  id: number;
  kind: "weapon" | "trinket";
  ref: string;
  name: string;
  rarity: string;
  slot: string;
  stat_bonus_json: string;
  equipped: number;
}

export interface Me {
  player: { id: string; name: string };
  character: Character | null;
  inventory: InventoryItem[];
  /** The crew whose Harbor this player shares, if any. The id doubles as the invite code. */
  crew: { id: string; name: string } | null;
}

export type { StatKey };

async function request<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(PROFILE ? { "x-gq-profile": PROFILE } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data as T;
}

let signingIn: Promise<unknown> | null = null;

/** Load the signed-in player, creating a guest account on first visit. */
export async function loadMe(): Promise<Me> {
  try {
    return await request<Me>("/api/me");
  } catch (err) {
    if ((err as { status?: number }).status !== 401) throw err;
    // Single-flight, so concurrent first loads share one guest account.
    signingIn ??= request("/api/auth/guest", {});
    await signingIn;
    return request<Me>("/api/me");
  }
}

export const api = {
  roll: (classId: string, name: string) => request<{ character: Character }>("/api/character/roll", { classId, name }),
  confirm: () => request("/api/character/confirm", {}),
  reroll: () => request("/api/character/reroll", {}),
  spend: (stat: StatKey) => request("/api/character/spend", { stat }),
  equip: (itemId: number) => request("/api/character/equip", { itemId }),
  createRun: () => request<{ code: string }>("/api/run", {}),
  createCrew: (name: string) => request("/api/crew", { name }),
  joinCrew: (code: string) => request("/api/crew/join", { code }),
  leaveCrew: () => request("/api/crew/leave", {}),
};
