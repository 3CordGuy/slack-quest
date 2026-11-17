// HTTP helpers for the Harbor screens.

import type { StatKey } from "@gantt-quest/core";
import type { ContractBoard } from "../server/board";

/** What the contract dealer in the pub has: the crew goal and the contracts on offer. */
export type Board = ContractBoard;
import type { Appearance, CarryState, FishSpot, GatherChoice, HarborXpStatus, GatherSpot, HarborWorks, HutSummary, ItemDef, Lodestone, Perk, ProjectAmounts, PublicHero, Resources, SalesEntry, SalesmanId, SalesmanVisit, ShopEntry, Throwable, TradeSide } from "@gantt-quest/world";
import { devTools } from "./devTools";
import { forcedSalesman } from "./salesmanClock";
import type { GatherStatus } from "../server/gather";
import type { SittingPaid } from "../server/fishing";
import type { FishStock } from "../server/fishmarket";
import type { CatchBook, PubWall } from "../server/catchbook";
import type { PubGame, PubLeaderboard, PubScore } from "../server/pub-scores";
import type { XpResult } from "../server/harbor-xp";
import type { TradeList } from "../server/trade";
import type { Chart, ChartNode } from "../server/atlas";
import type { HeldStone } from "../server/lodestones";
import type { ChestView } from "../server/townchest";
import type { ApothecaryView, GalleyKeeperView, HaggleResult, KeeperWare, SmithyView } from "../server/workshops";
import type { ErrandPaid, RegularsView } from "../server/errands";

export type { Chart, ChartNode, ChestView, HeldStone };
export type { ApothecaryView, SmithyView, GalleyKeeperView, ErrandPaid, RegularsView, HaggleResult, KeeperWare };

export type { CatchBook, FishStock, GatherStatus, PubGame, PubLeaderboard, PubScore, PubWall, SittingPaid, XpResult };

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
  /** Earned by filling the Catch Book. */
  title?: string | null;
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
  /** JSON list of picked class trait ids (parse with parseTraits). */
  traits?: string;
  /** JSON Appearance (parse with parseAppearance), or null if they never chose one. */
  appearance?: string | null;
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
  /** Steps of work at the smithy, already counted in `power`. */
  upgrades?: number;
  /** 1 while worn but not drawn on the hero. */
  hidden?: number;
}

/** The traveling salesman in the pub, if one is in, and their stock for this player; otherwise who is due next. */
export interface SalesmanView {
  here: (SalesmanVisit & { entries: (SalesEntry & { bought: boolean; problem: string | null })[] }) | null;
  next: { salesmanId: SalesmanId; startsAt: number } | null;
}

/** In the dev server, a forced visitor (see salesmanClock.ts) is passed on so the server agrees. */
const salesmanHeader = (): Record<string, string> => {
  const forced = forcedSalesman();
  return forced ? { "x-gq-salesman": forced } : {};
};

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
  /** The materials in the pack, by kind. They sit in stacks beside the gear. Absent from an older server. */
  materials?: Resources;
  /** The potions, flasks and bombs in the pack, by kind: used up on a map, and kept between maps. Absent from an older server. */
  consumables?: Partial<Record<Throwable, number>>;
  /** The lodestones in the pack: each kind held, and how many. */
  lodestones?: HeldStone[];
  /** How full the pack is, its size, what is in storage and whether there is a home for it. Null without a character. */
  carry: CarryState | null;
  /** The crew whose Harbor this player shares, if any. The id doubles as the invite code. */
  crew: { id: string; name: string } | null;
  /** Harbor XP still to be had today, from any pastime. Absent from an older server. */
  harborXp?: HarborXpStatus;
  /** On the ADMIN_EMAILS allow-list. Only shows the admin link; the server checks every admin call. */
  isAdmin: boolean;
  /** A development deployment (the worker's ENVIRONMENT is "dev"): show the dev toolbox. Absent from an older server. */
  devTools?: boolean;
  /** The newest release whose notes this player has read on the notice board. Null if never; absent from an older server. */
  seenRelease?: string | null;
}

export type { StatKey };

async function request<T>(path: string, body?: unknown, extra: Record<string, string> = {}): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? "GET" : "POST",
    headers: { "content-type": "application/json", ...(PROFILE ? { "x-gq-profile": PROFILE } : {}), ...extra },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) throw Object.assign(new Error(data.error ?? `Request failed (${res.status})`), { status: res.status });
  return data as T;
}

let signingIn: Promise<unknown> | null = null;

/** Load the signed-in player, creating a guest account on first visit. */
export async function loadMe(): Promise<Me> {
  const me = await fetchMe();
  devTools.set(me.devTools === true);
  return me;
}

async function fetchMe(): Promise<Me> {
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
  /** Another hero's public sheet (or your own): name, level, stats and worn gear. */
  hero: (id: string) => request<{ hero: PublicHero }>(`/api/hero/${encodeURIComponent(id)}`),
  suggestName: (classId: string, avoid: string[]) => request<{ name: string }>("/api/character/name", { classId, avoid }),
  roll: (classId: string, name: string) => request<{ character: Character }>("/api/character/roll", { classId, name }),
  confirm: () => request("/api/character/confirm", {}),
  setAppearance: (appearance: Appearance) => request("/api/character/appearance", { appearance }),
  reroll: () => request("/api/character/reroll", {}),
  spend: (stat: StatKey) => request("/api/character/spend", { stat }),
  pickTrait: (trait: string) => request("/api/character/trait", { trait }),
  equip: (itemId: number) => request("/api/character/equip", { itemId }),
  unequip: (itemId: number) => request("/api/character/unequip", { itemId }),
  /** Show or hide a worn piece on the hero; it counts either way. */
  hideGear: (itemId: number, hidden: boolean) => request("/api/character/hide", { itemId, hidden }),
  store: (itemId: number) => request("/api/inventory/store", { itemId }),
  sell: (itemId: number) => request<{ gold: number }>("/api/inventory/sell", { itemId }),
  sellMaterial: (kind: string, qty: number) => request<{ gold: number }>("/api/shop/materials/sell", { kind, qty }),
  shop: () => request<Shop>("/api/shop"),
  buy: (index: number) => request("/api/shop/buy", { index }),
  contracts: () => request<Board>("/api/contracts"),
  /** The notice board's release notes are read up to this release. */
  releaseSeen: (id: string) => request<{ seenRelease: string }>("/api/releases/seen", { id }),
  requestCode: (email: string) => request("/api/auth/email/request", { email }),
  verifyCode: (email: string, code: string) => request<{ outcome: "linked" | "signed_in" | "created" | "already" }>("/api/auth/email/verify", { email, code }),
  signOut: () => request("/api/auth/signout", {}),
  createCrew: (name: string) => request("/api/crew", { name }),
  joinCrew: (code: string) => request("/api/crew/join", { code }),
  leaveCrew: () => request("/api/crew/leave", {}),
  gather: () => request<GatherStatus & { sitting?: SittingPaid }>("/api/gather"),
  /** Kept fish: the icebox and the trophy chest, with today's prices. */
  fish: () => request<FishStock>("/api/fish"),
  sellFish: (ids: string[], to: "market" | "tam") => request<FishStock & { sold: { id: string; gold: number }[] }>("/api/fish/sell", { ids, to }),
  moveFish: (id: string, to: "trophy" | "icebox") => request<FishStock>("/api/fish/move", { id, to }),
  /** The Catch Book, with the crew's records. */
  catchBook: () => request<CatchBook>("/api/fish/book"),
  /** The pub's wall of record fish: hang yours, or take it down. */
  pubWall: () => request<PubWall>("/api/fish/wall"),
  wallFish: (fishId: string, down = false) => request<PubWall>("/api/fish/wall", { fishId, down }),
  /** Hang a fish from the trophy chest on a Mounted Fish at home, or take it down (null). */
  hangFish: (furnishingId: number, fishId: string | null) => request<{ ok: true }>("/api/fish/hang", { furnishingId, fishId }),
  rest: (place: "bedroll" | "hut") => request<GatherStatus & { regained: number }>("/api/rest", { place }),
  buyPlot: (plot: number) => request<{ plot: number }>("/api/hut/plot", { plot }),
  fillBin: () => request<{ put: Resources; bin: Resources | null }>("/api/hut/bin", {}),
  /** Start an outing. Fishing with a `pier` starts a sitting there. */
  gatherStart: (spot: GatherSpot, pier?: FishSpot) => request<GatherStatus>("/api/gather/start", { spot, pier }),
  gatherStep: (choice: GatherChoice) => request<GatherStatus & { paid?: Resources; xp?: XpResult; sitting?: SittingPaid }>("/api/gather/step", { choice }),
  pub: () => request<PubTab>("/api/pub"),
  pubLeaderboard: () => request<PubLeaderboard>("/api/pub/leaderboard"),
  pubOrder: (itemId: string) => request<PubTab>("/api/pub/order", { itemId }),
  pubTalk: (text: string) => request<{ say: string }>("/api/pub/talk", { text }),
  salesman: () => request<SalesmanView>("/api/pub/salesman", undefined, salesmanHeader()),
  buyFromSalesman: (index: number) => request<{ got: SalesEntry }>("/api/pub/salesman/buy", { index }, salesmanHeader()),
  regulars: () => request<RegularsView>("/api/pub/regulars"),
  errand: (regular: string, action: "accept" | "handin" | "trade" | "drop") => request<Partial<ErrandPaid> & { ok?: true }>("/api/pub/errand", { regular, action }),
  projects: () => request<Works>("/api/projects"),
  apothecary: () => request<ApothecaryView>("/api/apothecary"),
  brew: (brewId: string) => request<ApothecaryView & { xp?: XpResult }>("/api/apothecary/brew", { brewId }),
  brewFlask: (kind: string) => request<ApothecaryView & { xp?: XpResult }>("/api/apothecary/flask", { kind }),
  smithy: () => request<SmithyView>("/api/smithy"),
  smith: (itemId: number) => request<SmithyView & { worked: string; xp?: XpResult }>("/api/smithy/work", { itemId }),
  /** Buy something ready-made from a keeper's own stock, by its key. */
  buyFromApothecary: (key: string) => request<ApothecaryView & { got: string }>("/api/apothecary/buy", { key }),
  buyFromSmith: (key: string) => request<SmithyView & { got: string }>("/api/smithy/buy", { key }),
  /** Ask a keeper to take something off a price: `ask` is one of HAGGLE_ASKS. One try a day for each thing. */
  haggle: (shop: string, key: string, ask: string) => request<HaggleResult>("/api/keeper/haggle", { shop, key, ask }),
  galley: () => request<GalleyKeeperView>("/api/galley"),
  cook: (dishId: string) => request<GalleyKeeperView & { xp?: XpResult }>("/api/galley/cook", { dishId }),
  /** Buy a dish ready-made from the cook, by its key: it goes into the crew's larder. */
  buyFromCook: (key: string) => request<GalleyKeeperView & { got: string }>("/api/galley/buy", { key }),
  giveToProject: (projectId: string, give: ProjectAmounts) => request<Works & { completed: boolean; xp?: XpResult }>("/api/projects/give", { projectId, give }),
  hut: () => request<Hut>("/api/hut"),
  craft: (defId: string) => request<{ ok: true; xp?: XpResult }>("/api/hut/craft", { defId }),
  /** Materials into (qty > 0) or out of (qty < 0) one of your hut's containers. */
  stash: (container: number, kind: string, qty: number) => request("/api/hut/stash", { container, kind, qty }),
  /** Gear from the bag into a container, or (container null) back into the bag. */
  stow: (container: number | null, itemId: number) => request("/api/hut/stow", { container, itemId }),
  upgradeHut: () => request<{ tier: number }>("/api/hut/upgrade", {}),
  buyFurniture: (defId: string) => request("/api/shop/furniture", { defId }),
  sellFurniture: (furnishingId: number) => request<{ gold: number }>("/api/shop/furniture/sell", { furnishingId }),
  trades: () => request<TradeList>("/api/trade"),
  /** Open the trade table with a crewmate, or find the one already open between you. */
  openTrade: (to: string, run?: string) => request<{ id: number }>("/api/trade/open", { to, run }),
  /** Lay out your side of the table. */
  offerTrade: (id: number, side: TradeSide) => request<{ rev: number }>("/api/trade/offer", { id, side }),
  /** Accept the table as it stood at `rev`, or take that back. */
  acceptTrade: (id: number, rev: number, ok = true) => request<{ settled: boolean }>("/api/trade/accept", { id, rev, ok }),
  closeTrade: (id: number) => request("/api/trade/close", { id }),
  // The dev toolbox's seeding. The server answers these only on a development deployment (server/dev.ts).
  /** Add gold to your purse, or take it with a negative amount. */
  /** Everyone in your crew and the zone each is on, if any. */
  crewPlaces: () => request<{ members: { id: string; name: string; classId: string; level: number; zone: { code: string; fighting: boolean } | null }[] }>("/api/crew/places"),
  /** Where to go to join a crewmate: the zone they are on, or null for the Harbor. Refused while they are in a fight. */
  teleport: (to: string) => request<{ zone: string | null; name: string }>("/api/crew/teleport", { to }),
  /** The crew's chart: the Harbor, what is cleared, what is open, the fog beyond, and who is out on what. */
  atlas: () => request<Chart>("/api/atlas"),
  /** Set sail for a landfall: the map the crew is fighting through there, or a fresh one. */
  /** Set out for a place, with the lodestone put into its slot (what it carries, joined with "+"; "" for a plain one). It comes out of your pack. */
  openNode: (node: string, stone?: string) => request<{ code: string; fresh: boolean }>("/api/atlas/open", { node, stone }),
  /** The dev toolbox: clear a landfall without fighting for it, or wipe the chart. Gives the chart as it now is. */
  /** The crew's town chest: its tabs and what is in each. Every call below gives the chest back as it now is. */
  chest: () => request<ChestView>("/api/chest"),
  /** Put a piece of gear from your pack into a tab of the chest, or take one (by its id in the chest) out into your pack. */
  chestStow: (tab: number, item: number) => request<ChestView>("/api/chest/stow", { tab, item }),
  chestUnstow: (item: number) => request<ChestView>("/api/chest/unstow", { item }),
  /** Put `qty` of a kind of stack (a material, a lodestone) from your pack into a tab of the chest, or take it out. */
  chestPut: (tab: number, kind: string, qty: number) => request<ChestView>("/api/chest/put", { tab, kind, qty }),
  chestTake: (tab: number, kind: string, qty: number) => request<ChestView>("/api/chest/take", { tab, kind, qty }),
  /** Buy the chest another tab with your gold, for the whole crew; or give a tab another name, a colour (null for none), or another place among the tabs (from 0). */
  chestBuyTab: (name?: string) => request<ChestView>("/api/chest/tab", { name }),
  chestRenameTab: (tab: number, name: string) => request<ChestView>("/api/chest/rename", { tab, name }),
  chestColorTab: (tab: number, color: string | null) => request<ChestView>("/api/chest/color", { tab, color }),
  chestMoveTab: (tab: number, to: number) => request<ChestView>("/api/chest/move", { tab, to }),
  /** Work lodestones at the bench, out of your pack: fuse three (each as it is sent) into one, attune one to a modifier, or reroll one. */
  benchFuse: (stones: string[]) => request<{ made: Lodestone; lodestones: HeldStone[] }>("/api/atlas/bench", { op: "fuse", stones }),
  benchAttune: (stone: string, mod: string) => request<{ made: Lodestone; lodestones: HeldStone[] }>("/api/atlas/bench", { op: "attune", stone, mod }),
  benchTemper: (stone: string, mod: string) => request<{ made: Lodestone; lodestones: HeldStone[] }>("/api/atlas/bench", { op: "temper", stone, mod }),
  benchReroll: (stone: string) => request<{ made: Lodestone; lodestones: HeldStone[] }>("/api/atlas/bench", { op: "reroll", stone }),
  /** Cut a plain lodestone from stone and iron, into your pack. */
  cutStone: () => request<{ lodestones: HeldStone[] }>("/api/atlas/cut", {}),
  devAtlas: (op: "clear" | "reset" | "stone", node?: string) => request<Chart>("/api/dev/atlas", { op, node }),
  /** Down into the caves: the crew's cave still being fought through, or a fresh one. */
  caves: () => request<{ code: string; fresh: boolean }>("/api/caves", {}),
  /** Make a zone to try fights in, from these options (and a seed, or a fresh one), and get its code. */
  devZone: (options: Record<string, unknown>) => request<{ code: string; seed: string }>("/api/dev/zone", options),
  devGold: (amount: number) => request<{ gold: number }>("/api/dev/gold", { amount }),
  /** Put one piece of gear in your pack: a weapon or a base by its ref, at a rarity and level. */
  devGear: (ref: string, rarity: string, level: number) => request<{ item: ItemDef }>("/api/dev/gear", { ref, rarity, level }),
  /** Add some of one material to your pack, or take it with a negative amount. */
  devMaterial: (kind: string, qty: number) => request<{ kind: string; qty: number }>("/api/dev/material", { kind, qty }),
};
