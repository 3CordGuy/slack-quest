// HTTP helpers for the Harbor screens.

import type { StatKey } from "@gantt-quest/core";
import type { NoticeBoard } from "../server/board";

/** What the Harbor's notice board shows: the crew goal and the contracts on offer. */
export type Board = NoticeBoard;
import type { CarryState, GatherChoice, GatherSpot, HarborWorks, HutSummary, ItemDef, Perk, ProjectAmounts, Resources, ShopEntry, TradeOffer } from "@gantt-quest/world";
import type { GatherStatus } from "../server/gather";
import type { TradeList } from "../server/trade";

export type { GatherStatus };

/** What a hero has ordered at the pub and what it gives on their next voyage. */
export interface PubTab {
  orders: string[];
  buff: Required<Perk>;
  /** Set on an order: the meal gave back one gathering outing. */
  rested?: boolean;
}

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
  stored: number;
}

export interface Shop {
  refreshAt: number;
  entries: (ShopEntry & { bought: boolean })[];
}

/** What the player owns for their hut, the perks it gives right now, and their gold. */
export type Hut = HutSummary & { perks: Required<Perk>; gold: number };

export interface Me {
  /** `email` is null for a guest, whose account lives only in this browser. */
  player: { id: string; name: string; email: string | null };
  character: Character | null;
  /** What the hero has with them, worn and in the pack. Stored items are only listed inside their hut. */
  inventory: InventoryItem[];
  /** How full the pack is, its size, what is in storage and whether there is a home for it. Null without a character. */
  carry: CarryState | null;
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
  store: (itemId: number) => request("/api/inventory/store", { itemId }),
  sell: (itemId: number) => request<{ gold: number }>("/api/inventory/sell", { itemId }),
  sellMaterial: (kind: string, qty: number) => request<{ gold: number }>("/api/shop/materials/sell", { kind, qty }),
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
  gather: () => request<GatherStatus>("/api/gather"),
  rest: (place: "bedroll" | "hut") => request<GatherStatus & { regained: number }>("/api/rest", { place }),
  buyPlot: (plot: number) => request<{ plot: number }>("/api/hut/plot", { plot }),
  fillBin: () => request<{ put: Resources; bin: Resources | null }>("/api/hut/bin", {}),
  gatherStart: (spot: GatherSpot) => request<GatherStatus>("/api/gather/start", { spot }),
  gatherStep: (choice: GatherChoice) => request<GatherStatus & { paid?: Resources }>("/api/gather/step", { choice }),
  pub: () => request<PubTab>("/api/pub"),
  pubOrder: (itemId: string) => request<PubTab>("/api/pub/order", { itemId }),
  pubTalk: (text: string) => request<{ say: string }>("/api/pub/talk", { text }),
  projects: () => request<Works>("/api/projects"),
  giveToProject: (projectId: string, give: ProjectAmounts) => request<Works & { completed: boolean }>("/api/projects/give", { projectId, give }),
  hut: () => request<Hut>("/api/hut"),
  craft: (defId: string) => request("/api/hut/craft", { defId }),
  upgradeHut: () => request<{ tier: number }>("/api/hut/upgrade", {}),
  buyFurniture: (defId: string) => request("/api/shop/furniture", { defId }),
  trades: () => request<TradeList>("/api/trade"),
  proposeTrade: (offer: TradeOffer, run?: string) => request<{ id: number }>("/api/trade/propose", { ...offer, run }),
  acceptTrade: (id: number) => request("/api/trade/accept", { id }),
  closeTrade: (id: number) => request("/api/trade/close", { id }),
};
