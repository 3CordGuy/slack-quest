// The market stall in the Harbor: buy from a small stock that changes each
// day, and sell what you no longer want. Every row is compared against what
// you are wearing so an upgrade is obvious.

import { useEffect, useMemo, useState } from "react";
import { RARITY_COLOR, SLOT_LABEL, equipProblem, sellPrice } from "@gantt-quest/world";
import { api, type Me, type Shop } from "./api";
import { DragPanel } from "./DragPanel";
import { useAct } from "./Harbor";
import { Icon, ItemDetail, ItemTile, VerdictTag, bonusSummary, compare, powerLabel, toOwned } from "./items";

export function ShopScreen({ me, refresh, onClose }: { me: Me; refresh(): Promise<unknown>; onClose(): void }) {
  const c = me.character!;
  const [shop, setShop] = useState<Shop | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"buy" | "sell">("buy");
  const [picked, setPicked] = useState<{ tab: "buy" | "sell"; key: number } | null>(null);
  const load = () => api.shop().then(setShop, (e: Error) => setLoadError(e.message));
  const { busy, error, act } = useAct(async () => {
    await Promise.all([refresh(), load()]);
  });
  useEffect(() => {
    void load();
  }, []);

  const items = useMemo(() => me.inventory.map(toOwned), [me.inventory]);
  const worn = useMemo(() => new Map(items.filter((i) => i.equipped).map((i) => [i.slot, i])), [items]);
  const sellable = items.filter((i) => !i.equipped);
  const buying = picked?.tab === "buy" ? shop?.entries.find((e) => e.index === picked.key) : undefined;
  const selling = picked?.tab === "sell" ? sellable.find((i) => i.id === picked.key) : undefined;
  const hours = shop ? Math.max(0, Math.ceil((shop.refreshAt - Date.now()) / 3_600_000)) : 0;

  return (
    <div className="overlay inv-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="shop" title="Market stall" compact className="inv panel shop" role="dialog" aria-label="Market stall">
        <header className="inv-head">
          <h2>Market stall</h2>
          <button className={`small ${tab === "buy" ? "selected" : ""}`} onClick={() => setTab("buy")}>Buy</button>
          <button className={`small ${tab === "sell" ? "selected" : ""}`} onClick={() => setTab("sell")}>Sell <span className="muted">{sellable.length}</span></button>
          <span className="spacer" />
          <span className="gold"><Icon name="cash" color="#ffd23f" size={18} /> {c.gold} gold</span>
          <button onClick={onClose}>Close</button>
        </header>
        {(error ?? loadError) && <div className="banner error">{error ?? loadError}</div>}

        <div className="shop-body">
          <section className="shop-list">
            {tab === "buy" ? (
              <>
                {!shop && !loadError && <p className="muted">Laying out the wares…</p>}
                {shop?.entries.map((e) => {
                  const diff = compare(e.item, worn.get(e.item.slot) ?? null);
                  return (
                    <div key={e.index} className={`shop-row ${e.bought ? "sold" : ""} ${picked?.tab === "buy" && picked.key === e.index ? "selected" : ""}`} onClick={() => setPicked({ tab: "buy", key: e.index })}>
                      <ItemTile item={e.item} locked={!!equipProblem(e.item, c.class_id, c.level)} />
                      <div className="shop-info">
                        <strong style={{ color: RARITY_COLOR[e.item.rarity] }}>{e.item.name}</strong>
                        <span className="muted">
                          {SLOT_LABEL[e.item.slot]}{e.item.power > 0 && ` · +${e.item.power} ${powerLabel(e.item).toLowerCase()}`}{bonusSummary(e.item) && ` · ${bonusSummary(e.item)}`}
                        </span>
                      </div>
                      <VerdictTag verdict={diff.verdict} />
                      <button
                        className="primary"
                        disabled={busy || e.bought || c.gold < e.price}
                        onClick={(ev) => { ev.stopPropagation(); void act(() => api.buy(e.index)); }}
                      >
                        {e.bought ? "Sold" : `${e.price}g`}
                      </button>
                    </div>
                  );
                })}
                {shop && <p className="muted">New stock in about {hours} hour{hours === 1 ? "" : "s"}. The stall carries gear for your class and level.</p>}
              </>
            ) : (
              <>
                {sellable.length === 0 && <p className="muted">Nothing to sell. Equipped gear has to be taken off first.</p>}
                {sellable.map((item) => (
                  <div key={item.id} className={`shop-row ${picked?.tab === "sell" && picked.key === item.id ? "selected" : ""}`} onClick={() => setPicked({ tab: "sell", key: item.id })}>
                    <ItemTile item={item} />
                    <div className="shop-info">
                      <strong style={{ color: RARITY_COLOR[item.rarity] }}>{item.name}</strong>
                      <span className="muted">
                        {SLOT_LABEL[item.slot]}{item.power > 0 && ` · +${item.power} ${powerLabel(item).toLowerCase()}`}{bonusSummary(item) && ` · ${bonusSummary(item)}`}
                      </span>
                    </div>
                    <button disabled={busy} onClick={(ev) => { ev.stopPropagation(); void act(() => api.sell(item.id)); }}>Sell · {sellPrice(item)}g</button>
                  </div>
                ))}
              </>
            )}
          </section>
          <section className="inv-detail">
            {buying ? (
              <ItemDetail item={buying.item} current={worn.get(buying.item.slot) ?? null} classId={c.class_id} level={c.level} />
            ) : selling ? (
              <ItemDetail item={selling} current={worn.get(selling.slot) ?? null} classId={c.class_id} level={c.level} />
            ) : (
              <p className="muted">Pick something to see how it compares with what you are wearing.</p>
            )}
          </section>
        </div>
      </DragPanel>
    </div>
  );
}
