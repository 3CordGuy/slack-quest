// Trading with the traveling salesman in the pub's corner. The stock and its
// prices come from the server; one of each entry per player per visit.

import { useCallback, useEffect, useMemo, useState } from "react";
import { FURNISHINGS, RARITY_COLOR, SLOT_LABEL, dueIn, equipProblem, resourcesText, salesGoodsName, salesman, type SalesEntry } from "@gantt-quest/world";
import { api, type Me, type SalesmanView } from "./api";
import { DragPanel } from "./DragPanel";
import { Icon, ItemTile, VerdictTag, bonusSummary, compare, powerLabel, toOwned } from "./items";
import { blurb, itemName, label } from "./labels";

/** What the buyer is told once something changes hands. */
function gotText(entry: SalesEntry): string {
  const g = entry.goods;
  if (g.kind === "item") return `${itemName(g.item)} is in your pack.`;
  if (g.kind === "blueprint") return `You know how to build a ${label("furnishing", g.defId)} now. Craft it in your hut.`;
  if (g.kind === "furnishing") return `${label("furnishing", g.defId)} is in your hut's storage.`;
  return `${g.gold} gold for ${resourcesText(entry.materials)}.`;
}

export function SalesmanPanel({ me, refresh }: { me: Me; refresh(): Promise<unknown> }) {
  const c = me.character!;
  const [view, setView] = useState<SalesmanView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => api.salesman().then(setView, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
  }, [load, c.gold]);

  const worn = useMemo(() => new Map(me.inventory.map(toOwned).filter((i) => i.equipped).map((i) => [i.slot, i])), [me.inventory]);
  const here = view?.here;
  const who = here ? salesman(here.salesmanId) : undefined;

  const buy = async (entry: SalesEntry) => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      const { got } = await api.buyFromSalesman(entry.index);
      setDone(gotText(got));
      await Promise.all([refresh(), load()]);
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  };

  return (
    <DragPanel id="pub.salesman" title="Traveling salesman" className="story panel pub-bar salesman">
      {!view && !error && <p className="muted">Laying out the wares…</p>}
      {view && !here && <p className="muted">The corner is empty. The visitor has packed up and gone.</p>}
      {here && who && (
        <>
          <h3>{who.name} <span className="muted">· {who.trade}</span></h3>
          <p className="salesman-says">“{who.greeting}”</p>
          <div className="salesman-wares">
            {here.entries.map((e) => {
              const g = e.goods;
              const selling = g.kind === "gold";
              return (
                <div key={e.index} className={`shop-row ${e.bought ? "sold" : ""}`}>
                  {g.kind === "item" ? <ItemTile item={g.item} locked={!!equipProblem(g.item, c.class_id, c.level)} />
                    : g.kind === "blueprint" ? <Icon name="scroll-unfurled" color="#3f6fa8" size={36} />
                    : g.kind === "furnishing" ? <Icon name="crowned-heart" color="#e0b12e" size={36} />
                    : <Icon name={`res-${e.materials.herbs ? "herbs" : "mushrooms"}`} color="#6fae4a" size={36} />}
                  <div className="shop-info">
                    {g.kind === "item" ? <strong style={{ color: RARITY_COLOR[g.item.rarity] }}>{itemName(g.item)}</strong>
                      : selling ? <strong>{resourcesText(e.materials)}</strong>
                      : <strong>{salesGoodsName(g)}</strong>}
                    <span className="muted">
                      {g.kind === "item" ? <>{SLOT_LABEL[g.item.slot]}{g.item.power > 0 && ` · +${g.item.power} ${powerLabel(g.item).toLowerCase()}`}{bonusSummary(g.item) && ` · ${bonusSummary(g.item)}`}</>
                        : g.kind === "blueprint" ? <>Build it from {resourcesText(FURNISHINGS[g.defId]?.recipe ?? {})}. {blurb("furnishing", g.defId)}</>
                        : g.kind === "furnishing" ? <>{blurb("furnishing", g.defId)} Not sold at the stall.</>
                        : <>{Math.round((g.gold / ((e.materials.herbs ?? 0) + (e.materials.mushrooms ?? 0))) * 10) / 10}g a piece; the stall pays 3.</>}
                    </span>
                    {!e.bought && e.problem && <span className="bad small-note">{e.problem}</span>}
                  </div>
                  {g.kind === "item" && <VerdictTag verdict={compare(g.item, worn.get(g.item.slot) ?? null).verdict} />}
                  <button className="primary" disabled={busy || e.bought || !!e.problem} title={e.problem ?? ""} onClick={() => void buy(e)}>
                    {e.bought ? (selling ? "Sold" : "Bought") : selling ? `Sell · ${g.gold}g` : `${e.price}g`}
                  </button>
                </div>
              );
            })}
          </div>
          {done && <p className="good">{done}</p>}
          <p className="muted">One of each, per person, this visit. Packing up {dueIn(here.endsAt - Date.now())}.</p>
        </>
      )}
      {error && <p className="bad">{error}</p>}
    </DragPanel>
  );
}
