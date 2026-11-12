// The market stall in the Harbor: buy from a small stock that changes each
// day, and sell what you no longer want. Every row is compared against what
// you are wearing so an upgrade is obvious. The Furniture tab sells plain
// pieces for a hut, always in stock, at the catalogue's price.

import { useEffect, useMemo, useState } from "react";
import { RARITY_COLOR, RESOURCE_KINDS, SLOT_LABEL, STALL_BUYS, STALL_FURNITURE, equipProblem, sellPrice, type Resources } from "@gantt-quest/world";
import { api, type Me, type Shop } from "./api";
import { DragPanel } from "./DragPanel";
import { useAct } from "./Harbor";
import { Icon, ItemDetail, ItemTile, VerdictTag, bonusSummary, compare, powerLabel, toOwned } from "./items";
import { blurb, itemName, label } from "./labels";

export function ShopScreen({ me, refresh, onClose }: { me: Me; refresh(): Promise<unknown>; onClose(): void }) {
  const c = me.character!;
  const [shop, setShop] = useState<Shop | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [tab, setTab] = useState<"buy" | "sell" | "furniture">("buy");
  /** The furnishing last bought, and how many of it are now owned, so a purchase is visible. */
  const [bought, setBought] = useState<string | null>(null);
  const [picked, setPicked] = useState<{ tab: "buy" | "sell"; key: number } | null>(null);
  /** The player's materials, for the foraged goods the stall will buy. */
  const [stock, setStock] = useState<Resources>({});
  const load = () =>
    Promise.all([
      api.shop().then(setShop, (e: Error) => setLoadError(e.message)),
      api.hut().then((h) => setStock(h.resources), () => undefined),
    ]);
  const { busy, error, act } = useAct(async () => {
    await Promise.all([refresh(), load()]);
  });
  useEffect(() => {
    void load();
  }, []);

  const items = useMemo(() => me.inventory.map(toOwned), [me.inventory]);
  const worn = useMemo(() => new Map(items.filter((i) => i.equipped).map((i) => [i.slot, i])), [items]);
  const sellable = items.filter((i) => !i.equipped);
  const forage = RESOURCE_KINDS.filter((k) => STALL_BUYS[k] !== undefined);
  const forageHeld = forage.reduce((n, k) => n + (stock[k] ?? 0), 0);
  const buying = picked?.tab === "buy" ? shop?.entries.find((e) => e.index === picked.key) : undefined;
  const selling = picked?.tab === "sell" ? sellable.find((i) => i.id === picked.key) : undefined;
  const hours = shop ? Math.max(0, Math.ceil((shop.refreshAt - Date.now()) / 3_600_000)) : 0;

  return (
    <div className="overlay inv-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="shop" title="Market stall" compact resizable className="inv panel shop" role="dialog" aria-label="Market stall">
        <header className="inv-head">
          <h2>Market stall</h2>
          <button className={`small ${tab === "buy" ? "selected" : ""}`} onClick={() => setTab("buy")}>Buy</button>
          <button className={`small ${tab === "sell" ? "selected" : ""}`} onClick={() => setTab("sell")}>Sell <span className="muted">{sellable.length + (forageHeld > 0 ? 1 : 0)}</span></button>
          <button className={`small ${tab === "furniture" ? "selected" : ""}`} onClick={() => setTab("furniture")}>Furniture</button>
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
                        <strong style={{ color: RARITY_COLOR[e.item.rarity] }}>{itemName(e.item)}</strong>
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
            ) : tab === "furniture" ? (
              <>
                {bought && !busy && !error && <p className="good">{bought} bought. It is in your hut's storage.</p>}
                {STALL_FURNITURE.map((def) => (
                  <div key={def.id} className="shop-row">
                    <div className="shop-info">
                      <strong>{label("furnishing", def.id)}</strong>
                      <span className="muted">{blurb("furnishing", def.id)}</span>
                    </div>
                    <button
                      className="primary"
                      disabled={busy || c.gold < def.price!}
                      onClick={() => { setBought(null); void act(() => api.buyFurniture(def.id).then(() => setBought(label("furnishing", def.id)))); }}
                    >
                      {def.price}g
                    </button>
                  </div>
                ))}
                <p className="muted">Furniture goes to your hut's storage. Pieces that help on a voyage are crafted from blueprints, not sold.</p>
              </>
            ) : (
              <>
                <h3 className="shop-subhead">Herbs and mushrooms</h3>
                {forage.map((k) => {
                  const have = stock[k] ?? 0;
                  const each = STALL_BUYS[k]!;
                  return (
                    <div key={k} className="shop-row">
                      <Icon name={`res-${k}`} color="#6fae4a" size={32} />
                      <div className="shop-info">
                        <strong>{label("resource", k)}</strong>
                        <span className="muted">You have {have} · {each}g each</span>
                      </div>
                      <button disabled={busy || have < 1} onClick={() => void act(() => api.sellMaterial(k, 1))}>Sell 1 · {each}g</button>
                      <button disabled={busy || have < 2} onClick={() => void act(() => api.sellMaterial(k, have))}>Sell all · {each * have}g</button>
                    </div>
                  );
                })}
                <h3 className="shop-subhead">Gear</h3>
                {sellable.length === 0 && <p className="muted">Nothing to sell. Equipped gear has to be taken off first.</p>}
                {sellable.map((item) => (
                  <div key={item.id} className={`shop-row ${picked?.tab === "sell" && picked.key === item.id ? "selected" : ""}`} onClick={() => setPicked({ tab: "sell", key: item.id })}>
                    <ItemTile item={item} />
                    <div className="shop-info">
                      <strong style={{ color: RARITY_COLOR[item.rarity] }}>{itemName(item)}</strong>
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
            ) : tab === "furniture" ? (
              <p className="muted">Walk into your hut from its plot in the Harbor to put furniture down. The same pieces can be crafted there from wood, fur and copper.</p>
            ) : (
              <p className="muted">Pick something to see how it compares with what you are wearing.</p>
            )}
          </section>
        </div>
      </DragPanel>
    </div>
  );
}
