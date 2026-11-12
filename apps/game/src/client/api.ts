// HTTP helpers for the Harbor screens.

import type { StatKey } from "@gantt-quest/core";
import type { NoticeBoard } from "../server/board";

/** What the Harbor's notice board shows: the crew goal and the contracts on offer. */
export type Board = NoticeBoard;
import type { HarborWorks, HutSummary, ItemDef, Perk, ProjectAmounts, ShopEntry } from "@gantt-quest/world";

/** The crew's projects and what this player has to give toward them. */
export interface Works {
  works: HarborWorks;
  stock: ProjectAmounts;
}

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
  kind: ItemDef["kind"];
  ref: string;
  name: string;
  rarity: ItemDef["rarity"];
  slot: ItemDef["slot"];
  power: number;
  level_req: number;
  icon: string;
  stat_bonus_json: string;
  equipped: number;
}

export interface Shop {
  refreshAt: number;
  entries: (ShopEntry & { bought: boolean })[];
}

export interface Me {
  /** `email` is null for a guest, whose account lives only in this browser. */
  player: { id: string; name: string; email: string | null };
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
  unequip: (itemId: number) => request("/api/character/unequip", { itemId }),
  sell: (itemId: number) => request<{ gold: number }>("/api/inventory/sell", { itemId }),
  shop: () => request<Shop>("/api/shop"),
  buy: (index: number) => request("/api/shop/buy", { index }),
  board: () => request<Board>("/api/board"),
  createRun: () => request<{ code: string }>("/api/run", {}),
  requestCode: (email: string) => request("/api/auth/email/request", { email }),
  verifyCode: (email: string, code: string) => request<{ outcome: "linked" | "signed_in" | "created" | "already" }>("/api/auth/email/verify", { email, code }),
  signOut: () => request("/api/auth/signout", {}),
  createCrew: (name: string) => request("/api/crew", { name }),
  joinCrew: (code: string) => request("/api/crew/join", { code }),
  leaveCrew: () => request("/api/crew/leave", {}),
  projects: () => request<Works>("/api/projects"),
  giveToProject: (projectId: string, give: ProjectAmounts) => request<Works & { completed: boolean }>("/api/projects/give", { projectId, give }),
  hut: () => request<HutSummary & { perks: Required<Perk> }>("/api/hut"),
};
