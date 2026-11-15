// Trading with a crewmate, in the Harbor and on an island.
//
// `Trading` is mounted by any view where trading is allowed. It asks the
// server every few seconds for the player's open trades (every second while
// the table is open), so a crewmate who wants to trade shows up as a notice
// without anyone reloading, and what they lay on the table shows up as they
// lay it.
//
// The table itself is drawn by the bag's screen (InventoryScreen.tsx): the
// other player's side above, yours below, the bag beside them. This file
// keeps your side while you change it and sends it on, sends your acceptance
// with the table's rev (so you can only accept what you have seen), and
// closes the table when the trade goes through or either of you walks away.
// It runs the same checks as the server so the Accept button explains
// itself, but the server decides.

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { itemCells, sideIsEmpty, sideProblem, tradeRoomProblem, type TradeSide } from "@gantt-quest/world";
import type { TradeList, TradeOutcome, TradeView } from "../server/trade";
import { api, type Me } from "./api";
import { InventoryScreen } from "./InventoryScreen";
import { toOwned } from "./items";
import { itemName } from "./labels";
import "./trade.css";

/** How often the list is asked for: while the table is open, and while it is not. */
const LIVE_MS = 1000;
const IDLE_MS = 4000;
const NOTICE_MS = 7000;
/** Wait this long after the last change before sending your side, so typing an amount is one message. */
const SEND_AFTER_MS = 200;

export interface TradePartner {
  id: string;
  name: string;
}

/** What to tell the player about a trade that just closed, if anything. Their own clicks need no telling. */
function outcomeText(o: TradeOutcome): string | null {
  if (o.status === "accepted") return `The trade with ${o.other} went through.`;
  // Whoever did not open the table "declines" it; whoever did "withdraws" it.
  if ((o.mine && o.status === "declined") || (!o.mine && o.status === "withdrawn")) return `${o.other} cancelled the trade.`;
  if (o.status === "failed") return `The trade with ${o.other} fell through. ${o.reason ?? ""}`.trim();
  return null;
}

const sideOf = (view: TradeView["mine"]): TradeSide => ({ items: view.items.map((i) => i.id), gold: view.gold, resources: { ...view.resources } });

interface Props {
  me: Me;
  /** Who can be traded with here. */
  partners: TradePartner[];
  /** The crewmate the table is open with, or null while it is closed. */
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
  /** Your side of the open table as you have it, ahead of what the server has been told. */
  const [draft, setDraft] = useState<{ id: number; side: TradeSide } | null>(null);
  /** A change to your side has not reached the server yet. */
  const [unsent, setUnsent] = useState(false);
  const [busy, setBusy] = useState(false);
  /** What the server said when it refused the last thing asked of it. */
  const [said, setSaid] = useState<string | null>(null);
  const seen = useRef<Set<number> | null>(null);
  const latest = useRef({ refresh, onWith, withId });
  latest.current = { refresh, onWith, withId };
  const draftRef = useRef<{ id: number; side: TradeSide } | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const sending = useRef(false);

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
      // Gear, gold or materials just arrived or left.
      if (o.status === "accepted") void latest.current.refresh();
      const text = outcomeText(o);
      if (text) setNotice(text);
      // The table that just closed is the one on screen: put it away.
      if (latest.current.withId === o.otherId) latest.current.onWith(null);
    }
  }, []);

  useEffect(() => {
    void load();
    const every = setInterval(() => void load(), withId ? LIVE_MS : IDLE_MS);
    return () => clearInterval(every);
  }, [load, withId]);
  useEffect(() => {
    if (!notice) return;
    const t = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(t);
  }, [notice]);

  // Asking to trade with someone opens the table between you, or finds the one already open.
  useEffect(() => {
    if (!withId) return;
    let live = true;
    setSaid(null);
    api.openTrade(withId, run).then(
      () => live && void load(),
      (e: Error) => {
        if (!live) return;
        setNotice(e.message);
        latest.current.onWith(null);
      },
    );
    return () => {
      live = false;
    };
  }, [withId, run, load]);

  const open = list?.open ?? [];
  const table = withId ? open.find((t) => t.with.id === withId) : undefined;
  const partnerName = table?.with.name ?? partners.find((p) => p.id === withId)?.name ?? "your crewmate";

  // Your side starts as the server has it (a table reopened after a reload keeps what was on it).
  useEffect(() => {
    if (!table) {
      if (withId) return;
      draftRef.current = null;
      setDraft(null);
      setUnsent(false);
      return;
    }
    if (draftRef.current?.id === table.id) return;
    draftRef.current = { id: table.id, side: sideOf(table.mine) };
    setDraft(draftRef.current);
    setUnsent(false);
  }, [table, withId]);

  /** Send your side as it now is. If it changes again while it is on its way, send that too. */
  const flush = async () => {
    if (sending.current) return;
    sending.current = true;
    let refusedBy: string | null = null;
    try {
      for (;;) {
        const sent = draftRef.current;
        if (!sent) break;
        try {
          await api.offerTrade(sent.id, sent.side);
        } catch (e) {
          refusedBy = (e as Error).message;
          break;
        }
        if (draftRef.current === sent) break;
      }
    } finally {
      sending.current = false;
    }
    if (refusedBy) {
      // The server would not have it: show why, and go back to what it does hold.
      setSaid(refusedBy);
      draftRef.current = null;
    }
    await load();
    setUnsent(false);
  };
  const setMine = (side: TradeSide) => {
    if (!draftRef.current) return;
    draftRef.current = { id: draftRef.current.id, side };
    setDraft(draftRef.current);
    setUnsent(true);
    setSaid(null);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SEND_AFTER_MS);
  };
  useEffect(() => () => clearTimeout(timer.current), []);

  const accept = async (ok: boolean) => {
    if (!table) return;
    setBusy(true);
    setSaid(null);
    try {
      const res = await api.acceptTrade(table.id, table.rev, ok);
      if (res.settled) {
        // Your own click settled it: no need to be told by the list.
        seen.current?.add(table.id);
        setNotice(`The trade with ${table.with.name} went through.`);
        await refresh();
        onWith(null);
      }
    } catch (e) {
      setSaid((e as Error).message);
    } finally {
      await load();
      setBusy(false);
    }
  };
  /** Walk away from a table: it is cancelled for both. */
  const cancel = (t: TradeView | undefined) => {
    if (t) {
      seen.current?.add(t.id);
      void api.closeTrade(t.id).catch(() => undefined).finally(() => void load());
    }
    if (withId && (!t || t.with.id === withId)) onWith(null);
  };

  const c = me.character;
  const mine = draft && table && draft.id === table.id ? draft.side : null;
  const theirs = useMemo(() => (table ? { gear: table.theirs.items.map(toOwned), resources: table.theirs.resources, gold: table.theirs.gold, missing: table.theirs.missing } : null), [table]);
  /** Why the table cannot be accepted as it stands: the same checks the server makes when you do. */
  const problem = (() => {
    if (!table || !mine || !theirs || !c) return null;
    if (sideIsEmpty(mine) && theirs.gear.length === 0 && theirs.gold === 0 && Object.keys(theirs.resources).length === 0) return "Put something in the trade first.";
    const held = { gold: c.gold, resources: me.materials ?? {}, items: me.inventory.map((i) => ({ id: i.id, equipped: !!i.equipped, name: itemName(i), cells: itemCells(i) })) };
    const short = sideProblem(mine, held);
    if (short) return short;
    if (!me.carry) return null;
    const cells = (ids: number[]) => ids.reduce((n, id) => n + (held.items.find((i) => i.id === id)?.cells ?? 1), 0);
    return tradeRoomProblem(me.carry, held.resources, { cells: cells(mine.items), resources: mine.resources }, { cells: theirs.gear.reduce((n, g) => n + itemCells(g), 0), resources: theirs.resources });
  })();

  return (
    <>
      {!withId && (open.length > 0 || notice) && (
        <div className="trade-notices" role="status">
          {notice && <div className="trade-notice panel">{notice}</div>}
          {open.map((t) => (
            <div key={t.id} className="trade-notice panel incoming">
              <span>{t.opened ? <>Your trade with <strong>{t.with.name}</strong> is still open.</> : <><strong>{t.with.name}</strong> wants to trade.</>}</span>
              <button className="small primary" onClick={() => onWith(t.with.id)}>Look</button>
              <button className="small" onClick={() => cancel(t)}>{t.opened ? "Cancel" : "No thanks"}</button>
            </div>
          ))}
        </div>
      )}
      {withId && c && (table && mine && theirs ? (
        <InventoryScreen
          me={me}
          refresh={refresh}
          // Closing the screen walks away from the table.
          onClose={() => cancel(table)}
          onIsland={!!run}
          trade={{
            with: table.with.name,
            // A change of yours that is still on its way has already taken both acceptances back.
            theirs: { ...theirs, ok: table.theirs.ok && !unsent },
            mine,
            mineOk: table.mine.ok && !unsent,
            setMine,
            problem,
            note: said,
            busy: busy || unsent,
            accept: (ok) => void accept(ok),
          }}
        />
      ) : (
        <div className="trade-notices" role="status">
          <div className="trade-notice panel">Opening the trade with {partnerName}…</div>
        </div>
      ))}
    </>
  );
}
