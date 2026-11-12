// Giving and trading with a crewmate, in the Harbor and on an island.
//
// `Trading` is mounted by any view where trading is allowed. It asks the
// server every few seconds for the player's open offers, so an offer from a
// crewmate shows up as a notice without anyone reloading, and it owns the
// panel: either the one open offer between the two players (to accept,
// decline or withdraw) or a form to make one. The form runs the same checks
// as the server so the button explains itself, but the server decides.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { RESOURCE_KINDS, RESOURCE_LABEL, TRADE_MAX_ITEMS, carryProblem, isGift, tradeGoodsText, tradeProblem, type ResourceKind, type Resources, type TradeGoods, type TradeOffer } from "@gantt-quest/world";
import type { TradeList, TradeOutcome, TradeView } from "../server/trade";
import { api, type Me } from "./api";
import { DragPanel } from "./DragPanel";
import { ResourceChips } from "./hutDrops";
import { Icon, ItemTile, toOwned } from "./items";
import "./trade.css";

const POLL_MS = 4000;
const NOTICE_MS = 7000;

export interface TradePartner {
  id: string;
  name: string;
}

/** What to tell the player about an offer that just closed, if anything. Their own clicks need no telling. */
function outcomeText(o: TradeOutcome): string | null {
  if (o.mine && o.status === "accepted") return `${o.other} accepted your offer.`;
  if (o.mine && o.status === "declined") return `${o.other} declined your offer.`;
  if (o.mine && o.status === "failed") return `Your offer to ${o.other} fell through. ${o.reason ?? ""}`.trim();
  if (!o.mine && o.status === "withdrawn") return `${o.other} withdrew their offer.`;
  return null;
}

interface Props {
  me: Me;
  /** Who can be traded with here. */
  partners: TradePartner[];
  /** The crewmate the panel is open for, or null while it is closed. */
  withId: string | null;
  onWith(id: string | null): void;
  /** Reload the player's character and inventory. */
  refresh(): Promise<unknown>;
  /** The voyage this is shown on, when on an island. */
  run?: string;
}

export function Trading({ me, partners, withId, onWith, refresh, run }: Props) {
  const [list, setList] = useState<TradeList | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  /** Bumped whenever goods may have moved, so the form re-reads what the player holds. */
  const [moved, setMoved] = useState(0);
  const seen = useRef<Set<number> | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  const load = useCallback(async () => {
    let next: TradeList;
    try {
      next = await api.trades();
    } catch {
      // Offline for a moment: the next poll tries again.
      return;
    }
    setList(next);
    // Outcomes already there when the view opened are old news.
    const first = seen.current === null;
    seen.current ??= new Set();
    for (const o of next.recent) {
      if (seen.current.has(o.id)) continue;
      seen.current.add(o.id);
      if (first) continue;
      if (o.status === "accepted") {
        // Gear, gold or materials just arrived or left.
        void refreshRef.current();
        setMoved((n) => n + 1);
      }
      const text = outcomeText(o);
      if (text) setNotice(text);
    }
  }, []);

  useEffect(() => {
    void load();
    const timer = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(timer);
  }, [load]);
  useEffect(() => {
    if (!notice) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  const myId = me.player.id;
  const incoming = (list?.open ?? []).filter((t) => t.to.id === myId);
  const between = withId ? (list?.open ?? []).find((t) => t.from.id === withId || t.to.id === withId) : undefined;
  const partnerName = partners.find((p) => p.id === withId)?.name ?? (between ? (between.from.id === withId ? between.from.name : between.to.name) : "your crewmate");

  /** After the player acts on an offer themselves: do not announce it back to them, and show what is true now. */
  const acted: Acted = async (id, goodsMoved, said) => {
    if (id !== null) seen.current?.add(id);
    setNotice(said ?? null);
    if (goodsMoved) {
      await refresh();
      setMoved((n) => n + 1);
    }
    await load();
  };

  return (
    <>
      {!withId && (incoming.length > 0 || notice) && (
        <div className="trade-notices" role="status">
          {notice && <div className="trade-notice panel">{notice}</div>}
          {incoming.map((t) => (
            <div key={t.id} className="trade-notice panel incoming">
              <span><strong>{t.from.name}</strong> {t.gift ? "wants to give you something." : "offers you a trade."}</span>
              <button className="small primary" onClick={() => onWith(t.from.id)}>Look</button>
            </div>
          ))}
        </div>
      )}
      {withId && me.character && (
        <div className="overlay" onClick={(e) => e.target === e.currentTarget && onWith(null)}>
          <DragPanel id="trade" title="Trade" compact className="panel trade-panel" role="dialog" aria-label={`Trade with ${partnerName}`}>
            <header className="trade-head">
              <h2>Trade with {partnerName}</h2>
              <span className="spacer" />
              <button className="small" onClick={() => onWith(null)}>Close</button>
            </header>
            {notice && <p className="good" role="status">{notice}</p>}
            {!list ? <p className="muted">Checking for offers…</p>
              : between ? <Offer key={between.id} trade={between} mine={between.from.id === myId} acted={acted} carry={me.carry} />
              : <Compose key={moved} me={me} to={{ id: withId, name: partnerName }} run={run} acted={acted} />}
          </DragPanel>
        </div>
      )}
    </>
  );
}

/** One side of an offer: item tiles, then gold and materials as chips. */
function Goods({ goods, items = [] }: { goods: TradeGoods; items?: TradeView["give"]["items"] }) {
  const nothing = items.length === 0 && !tradeGoodsText(goods);
  if (nothing) return <p className="muted">Nothing.</p>;
  return (
    <div className="trade-goods">
      {items.length > 0 && (
        <ul className="trade-items">
          {items.map((row) => {
            const item = toOwned(row);
            return (
              <li key={row.id}>
                <ItemTile item={item} />
                <span><strong>{item.name}</strong><br /><span className="muted">{item.rarity}</span></span>
              </li>
            );
          })}
        </ul>
      )}
      <div className="res-chips">
        {goods.gold > 0 && (
          <span className="res-chip" title="Gold">
            <Icon name="cash" color="#ffd23f" size={22} />
            <strong>{goods.gold}</strong>
            <span className="res-name">Gold</span>
          </span>
        )}
      </div>
      <ResourceChips resources={goods.resources} />
    </div>
  );
}

/** `said` is shown to the player once the lists have caught up. */
type Acted = (id: number | null, goodsMoved: boolean, said?: string) => Promise<void>;

/** The open offer between the two players, with the buttons that settle it. */
function Offer({ trade, mine, acted, carry }: { trade: TradeView; mine: boolean; acted: Acted; carry: Me["carry"] }) {
  const [busy, setBusy] = useState(false);
  /** The gear in it must fit in your pack. The server checks again. */
  const full = !mine && carry ? carryProblem(carry, trade.give.items.length) : null;
  const [error, setError] = useState<string | null>(null);
  const settle = async (accept: boolean) => {
    setBusy(true);
    setError(null);
    try {
      await (accept ? api.acceptTrade(trade.id) : api.closeTrade(trade.id));
      await acted(trade.id, accept, accept ? (trade.gift ? `${trade.from.name}'s gift is yours.` : `The trade with ${trade.from.name} went through.`) : mine ? "Offer withdrawn." : "Offer declined.");
    } catch (e) {
      setError((e as Error).message);
      // The offer may have been closed by that; show what is true now.
      await acted(trade.id, false);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="trade-offer">
      {trade.runCode && <p className="muted">Made on the island. It can be settled while you are both ashore there.</p>}
      <h3>{mine ? `You offer ${trade.to.name}` : `${trade.from.name} offers you`}</h3>
      <Goods goods={trade.give} items={trade.give.items} />
      {trade.give.missing > 0 && (
        <p className="bad">
          {trade.give.missing === 1 ? "One item" : `${trade.give.missing} items`} in this offer {trade.give.missing === 1 ? "is" : "are"} no longer {mine ? "yours" : `${trade.from.name}'s`} to give. It cannot go through as it stands.
        </p>
      )}
      <h3>{trade.gift ? "A gift: nothing is asked in return" : mine ? "And you ask for" : "And asks you for"}</h3>
      {!trade.gift && <Goods goods={trade.ask} />}
      {full && !error && <p className="bad">{full}</p>}
      {error && <p className="bad" role="alert">{error}</p>}
      <div className="row">
        {mine ? (
          <>
            <button disabled={busy} onClick={() => settle(false)}>Withdraw the offer</button>
            <span className="muted">Waiting for {trade.to.name} to answer.</span>
          </>
        ) : (
          <>
            <button className="primary" disabled={busy || !!full} onClick={() => settle(true)}>{trade.gift ? "Accept the gift" : "Accept the trade"}</button>
            <button disabled={busy} onClick={() => settle(false)}>Decline</button>
          </>
        )}
      </div>
    </div>
  );
}

type Amounts = Partial<Record<"gold" | ResourceKind, string>>;

const whole = (text: string | undefined) => Math.max(0, Math.floor(Number(text ?? 0)) || 0);

function goodsOf(amounts: Amounts): TradeGoods {
  const resources: Resources = {};
  for (const kind of RESOURCE_KINDS) if (whole(amounts[kind]) > 0) resources[kind] = whole(amounts[kind]);
  return { gold: whole(amounts.gold), resources };
}

function AmountInput({ label, have, value, onChange }: { label: string; have?: number; value: string | undefined; onChange(text: string): void }) {
  return (
    <label className="trade-amount">
      <span>{label}{have !== undefined && <span className="muted"> · {have}</span>}</span>
      <input type="number" min={0} max={have} step={1} inputMode="numeric" placeholder="0" value={value ?? ""} onChange={(e) => onChange(e.target.value)} />
    </label>
  );
}

/** The form for a new offer: what to hand over, and optionally what to ask back. */
function Compose({ me, to, run, acted }: { me: Me; to: TradePartner; run?: string; acted: Acted }) {
  const [held, setHeld] = useState<Resources | null>(null);
  const [picked, setPicked] = useState<number[]>([]);
  const [give, setGive] = useState<Amounts>({});
  const [ask, setAsk] = useState<Amounts>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.hut().then((hut) => live && setHeld(hut.resources), () => live && setHeld({}));
    return () => {
      live = false;
    };
  }, []);

  const gold = me.character?.gold ?? 0;
  const pack = useMemo(() => me.inventory.filter((i) => !i.equipped), [me.inventory]);
  // Items that have left the pack since they were picked (sold in another tab) drop out of the offer.
  const items = picked.filter((id) => pack.some((i) => i.id === id));
  const offer: TradeOffer = { to: to.id, give: { ...goodsOf(give), items }, ask: goodsOf(ask) };
  const empty = items.length === 0 && !tradeGoodsText(offer.give);
  const problem = tradeProblem(offer, {
    from: me.player.id,
    giver: { gold, resources: held ?? {}, items: me.inventory.map((i) => ({ id: i.id, equipped: !!i.equipped, name: i.name })) },
  });
  const giveText = [...(items.length ? [`${items.length} item${items.length === 1 ? "" : "s"}`] : []), tradeGoodsText(offer.give)].filter(Boolean).join(", ");

  const toggle = (id: number) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : [...p, id]));
  const submit = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.proposeTrade(offer, run);
      await acted(null, false, `Offered. Waiting for ${to.name} to answer.`);
    } catch (e) {
      setError((e as Error).message);
      await acted(null, false);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="trade-compose">
      <p className="muted">Hand {to.name} gear you are not wearing, gold or hut materials. Ask for something back to make it a trade; ask for nothing and it is a gift. Nothing moves until {to.name} accepts.</p>
      <h3>You give</h3>
      {pack.length === 0 ? (
        <p className="muted">Nothing in your pack. Gear you are wearing has to come off first.</p>
      ) : (
        <div className="pack-grid" aria-label={`Up to ${TRADE_MAX_ITEMS} items`}>
          {pack.map((row) => {
            const item = toOwned(row);
            return <ItemTile key={row.id} item={item} selected={items.includes(row.id)} onClick={() => toggle(row.id)} />;
          })}
        </div>
      )}
      <div className="trade-amounts">
        <AmountInput label="Gold" have={gold} value={give.gold} onChange={(v) => setGive((a) => ({ ...a, gold: v }))} />
        {RESOURCE_KINDS.filter((k) => (held?.[k] ?? 0) > 0).map((k) => (
          <AmountInput key={k} label={RESOURCE_LABEL[k]} have={held![k]} value={give[k]} onChange={(v) => setGive((a) => ({ ...a, [k]: v }))} />
        ))}
      </div>
      <h3>You ask for <span className="muted">(optional)</span></h3>
      <div className="trade-amounts">
        <AmountInput label="Gold" value={ask.gold} onChange={(v) => setAsk((a) => ({ ...a, gold: v }))} />
        {RESOURCE_KINDS.map((k) => (
          <AmountInput key={k} label={RESOURCE_LABEL[k]} value={ask[k]} onChange={(v) => setAsk((a) => ({ ...a, [k]: v }))} />
        ))}
      </div>
      {!empty && (
        <p className="trade-summary">
          {to.name} gets <strong>{giveText}</strong>{isGift(offer) ? ", as a gift." : <> for <strong>{tradeGoodsText(offer.ask)}</strong>.</>}
        </p>
      )}
      {!empty && problem && <p className="bad">{problem}</p>}
      {error && <p className="bad" role="alert">{error}</p>}
      <div className="row">
        <button className="primary" disabled={busy || !!problem} onClick={submit}>{isGift(offer) ? `Offer it to ${to.name}` : `Offer the trade to ${to.name}`}</button>
      </div>
    </div>
  );
}
