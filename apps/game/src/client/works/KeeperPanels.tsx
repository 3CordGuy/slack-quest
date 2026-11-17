// Dealing with the smith or the apothecary, standing in front of them in
// their shop (KeeperView): what they sell from their own stock for gold, and
// what they do with what you bring. The keeper and what you hold stay at the
// top; the list of items and services scrolls under them. The hotbar is put
// away meanwhile; "Step away" walks you back from the keeper and brings it back.
//
// Anything with a gold price can be haggled over, once a day: pick how much
// to ask off, and the server rolls for whether the keeper agrees.
//
// What can be done is worked out here only to grey out buttons; the server
// checks every purchase, brew, step and haggle again.

import { useMemo, useState, type ReactNode } from "react";
import { BREWS, FLASK_RECIPES, HAGGLE_ASKS, KEEPER_PLACES, RARITY_COLOR, SHELF_DAILY, SLOT_LABEL, SMITHY_MAX_STEPS, THROWABLES, THROWABLE_KINDS, brewBuff, brewProblem, equipProblem, flaskProblem, haggledPrice, smithyProblem, smithyWork, upgradedName, workKey, type Deal, type HaggleAsk, type KeeperShop, type Resources, type Throwable } from "@gantt-quest/world";
import { api, type ApothecaryView, type HaggleResult, type KeeperWare, type Me, type SmithyView } from "../api";
import { DragPanel } from "../DragPanel";
import { CostChips, RewardChips, perkText } from "../hutDrops";
import { Icon, ItemTile, VerdictTag, bonusSummary, compare, powerLabel, toOwned } from "../items";
import { itemName, label } from "../labels";
import { regularFace } from "../RegularPanel";
import { GOLD_ICON, ThingIcon, brewIcon } from "../thingIcons";
import { ITEM_ICON } from "../zone/actionIcons";
import "./works.css";

/** "3 herbs, 1 bone", with the resources' own (possibly renamed) labels. */
const amountsText = (gold: number, r: Resources) =>
  [gold > 0 ? `${gold} gold` : "", ...Object.entries(r).filter(([, n]) => n).map(([k, n]) => `${n} ${label("resource", k).toLowerCase()}`)].filter(Boolean).join(", ");

/** What the panel shows after something is done: the keeper's word on it, or what went wrong. */
interface Said {
  text: string;
  tone: "good" | "bad" | "plain";
}

/** A gold price, with the list price struck through beside it once it has been talked down. */
function Price({ list, price }: { list: number; price: number }) {
  return (
    <span className="keeper-price">
      <ThingIcon icon={GOLD_ICON} size={16} />
      {price < list && <s className="muted">{list}g</s>}
      <strong>{price}g</strong>
    </span>
  );
}

/** What came of haggling over something, as a small tag on its row. */
function DealTag({ deal }: { deal: Deal | null }) {
  if (!deal) return null;
  return deal.pct > 0 ? <span className="tag good" title="Talked down today. The price holds until the day turns.">{deal.pct}% off today</span> : <span className="tag" title="You asked, and the answer was no. Try again tomorrow.">Price holds today</span>;
}

/** The three things to ask for, each with what it takes off and the chance of it. Shown under the row being haggled over. */
function HaggleAsks({ list, chances, busy, onAsk, onCancel }: { list: number; chances: Record<HaggleAsk, number>; busy: boolean; onAsk(ask: HaggleAsk): void; onCancel(): void }) {
  return (
    <div className="keeper-asks" role="group" aria-label="Haggle">
      <span className="muted small-note">One try today. The more you ask, the less likely it lands.</span>
      <div className="keeper-ask-row">
        {HAGGLE_ASKS.map((a) => (
          <button key={a.id} className="small" disabled={busy} onClick={() => onAsk(a.id)} title={`${a.pct}% off: ${list}g down to ${haggledPrice(list, a.pct)}g. About a ${chances[a.id]}% chance.`}>
            {a.label}
            <span className="keeper-ask-odds">−{a.pct}% · {chances[a.id]}% chance</span>
          </button>
        ))}
        <button className="small" disabled={busy} onClick={onCancel}>Never mind</button>
      </div>
    </div>
  );
}

/** The shared frame: the keeper at the top, what you hold, the last word, and the scrolling list. */
function Frame({ shop, said, hold, onDone, children }: { shop: KeeperShop; said: Said | null; hold: ReactNode; onDone(): void; children: ReactNode }) {
  const { keeper, title } = KEEPER_PLACES[shop];
  return (
    <DragPanel id={`keeper.${shop}`} title={title} className={`story panel pub-bar keeper-panel keeper-${shop}`}>
      <div className="keeper-top">
        <div className="regular-head">
          <img className="regular-face" src={regularFace(keeper.look)} alt="" />
          <div>
            <h3>{keeper.name} <span className="muted">· {keeper.trade}</span></h3>
            <p className={`salesman-says ${said?.tone === "bad" ? "bad" : said?.tone === "good" ? "good" : ""}`} role="status">{said ? said.text : `“${keeper.line}”`}</p>
          </div>
        </div>
        <div className="keeper-hold">
          {hold}
          <button className="small" onClick={onDone} title="Step back from the keeper: the hotbar comes back">Step away</button>
        </div>
      </div>
      <div className="keeper-list" tabIndex={0} aria-label="Items and services">{children}</div>
    </DragPanel>
  );
}

/** Everything the two panels share: what is busy, which row is being haggled over, and the last word. */
function useDealing(shop: KeeperShop, reload: () => Promise<unknown>, refresh: () => Promise<unknown>, onSay: (text: string) => void) {
  const [busy, setBusy] = useState(false);
  const [said, setSaid] = useState<Said | null>(null);
  /** The key of the row whose asks are showing. */
  const [haggling, setHaggling] = useState<string | null>(null);

  /** Run one request; on failure say why, and read the shop again in case it has changed. */
  const run = async (work: () => Promise<Said | void>) => {
    setBusy(true);
    setSaid(null);
    try {
      const done = await work();
      if (done) setSaid(done);
    } catch (e) {
      setSaid({ text: (e as Error).message, tone: "bad" });
      void reload();
    } finally {
      setBusy(false);
    }
  };

  const haggle = (key: string, ask: HaggleAsk) =>
    run(async () => {
      const res: HaggleResult = await api.haggle(shop, key, ask);
      setHaggling(null);
      onSay(res.line);
      await reload();
      return { text: `“${res.line}” ${res.won ? `${res.list}g comes down to ${res.price}g, for today.` : "The price holds, for today."}`, tone: res.won ? "good" : "plain" };
    });

  return { busy, said, haggling, setHaggling, run, haggle, refresh };
}

/** The Haggle button for a row, or nothing if it has been tried today or cannot be. */
function HaggleButton({ entry, deal, list, open, busy, disabled, onOpen }: { entry: string; deal: Deal | null; list: number; open: boolean; busy: boolean; disabled?: boolean; onOpen(key: string | null): void }) {
  if (deal || list <= 0) return null;
  return (
    <button className={`small keeper-haggle ${open ? "selected" : ""}`} disabled={busy || disabled} aria-expanded={open} title="Ask for something off the price. One try today." onClick={() => onOpen(open ? null : entry)}>
      Haggle
    </button>
  );
}

// ---------- the apothecary ----------

export function ApothecaryKeeperPanel({ view, setView, reload, refresh, onSay, onDone }: {
  view: ApothecaryView;
  setView(view: ApothecaryView): void;
  /** Fetch the shop again. */
  reload(): Promise<unknown>;
  /** Fetch the hero again (gold, the pack). */
  refresh(): Promise<unknown>;
  /** The keeper says something out loud, over his head. */
  onSay(text: string): void;
  /** Step back from the keeper, which puts the panel away. */
  onDone(): void;
}) {
  const d = useDealing("apothecary", reload, refresh, onSay);
  const bagBuff = perkText(brewBuff(view.bag));

  const buy = (ware: KeeperWare) =>
    d.run(async () => {
      const res = await api.buyFromApothecary(ware.key);
      setView(res);
      void refresh();
      return { text: `${res.got} goes into your pack, for ${ware.price}g.`, tone: "good" };
    });
  const brewFlask = (kind: Throwable) =>
    d.run(async () => {
      const res = await api.brewFlask(kind);
      setView(res);
      void refresh();
      return { text: `${THROWABLES[kind].name}: one more in your pack, ${res.carried[kind] ?? 1} in all.${res.xp?.text ? ` ${res.xp.text}` : ""}`, tone: "good" };
    });
  const brew = (id: string, name: string) =>
    d.run(async () => {
      const res = await api.brew(id);
      setView(res);
      void refresh();
      return { text: `A ${name} goes into your bag.${res.xp?.text ? ` ${res.xp.text}` : ""}`, tone: "good" };
    });

  return (
    <Frame
      shop="apothecary"
      said={d.said}
      onDone={onDone}
      hold={<p className="works-stock">You hold: <RewardChips zeros gold={view.gold} resources={{ herbs: view.resources.herbs ?? 0, mushrooms: view.resources.mushrooms ?? 0, bone: view.resources.bone ?? 0, wood: view.resources.wood ?? 0, copper: view.resources.copper ?? 0, fur: view.resources.fur ?? 0, slime: view.resources.slime ?? 0 }} /></p>}
    >
      <h4 className="keeper-section">On the shelf <span className="muted">· ready-made, for gold · {SHELF_DAILY} of each a day</span></h4>
      <ul className="workshop-list">
        {view.wares.map((w) => {
          if (w.goods.kind !== "flask") return null;
          const kind = w.goods.flask;
          const def = THROWABLES[kind];
          const open = d.haggling === w.key;
          return (
            <li key={w.key} className={`keeper-row ${w.left <= 0 ? "sold" : ""}`} data-ware={w.key}>
              <div className="keeper-line">
                <Icon name={ITEM_ICON[kind].name} color={ITEM_ICON[kind].color} size={36} />
                <span className="grow">
                  <strong>{def.name}{w.goods.qty > 1 ? ` × ${w.goods.qty}` : ""}</strong> <span className="muted">· you carry {view.carried[kind] ?? 0} · {w.left} left today</span>
                  <br />
                  <span className="muted small-note">{def.blurb}</span>
                  <br />
                  <Price list={w.list} price={w.price} /> <DealTag deal={w.deal} />
                </span>
                <span className="keeper-buttons">
                  <button className="small primary" disabled={d.busy || !!w.problem} title={w.problem ?? `Buy for ${w.price} gold`} onClick={() => void buy(w)}>{w.left <= 0 ? "Sold out" : `Buy · ${w.price}g`}</button>
                  <HaggleButton entry={w.key} deal={w.deal} list={w.list} open={open} busy={d.busy} disabled={w.left <= 0} onOpen={d.setHaggling} />
                </span>
              </div>
              {open && <HaggleAsks list={w.list} chances={view.chances} busy={d.busy} onAsk={(ask) => void d.haggle(w.key, ask)} onCancel={() => d.setHaggling(null)} />}
            </li>
          );
        })}
      </ul>

      <h4 className="keeper-section">Brewed from what you bring <span className="muted">· for your pack · no charge but the makings</span></h4>
      <ul className="workshop-list">
        {THROWABLE_KINDS.map((kind) => {
          const def = THROWABLES[kind];
          const have = view.carried[kind] ?? 0;
          const problem = flaskProblem(kind, view);
          return (
            <li key={kind} className={have > 0 ? "having" : ""} data-flask={kind}>
              <Icon name={ITEM_ICON[kind].name} color={ITEM_ICON[kind].color} size={36} />
              <span className="grow">
                <strong>{def.name}</strong> <span className="muted">· you carry {have}</span>
                <br />
                <CostChips cost={FLASK_RECIPES[kind]} have={view.resources} />
              </span>
              <button className="small" disabled={d.busy || !!problem} title={problem ?? `Brew one more ${def.name.toLowerCase()}`} onClick={() => void brewFlask(kind)}>Brew</button>
            </li>
          );
        })}
      </ul>

      <h4 className="keeper-section">For your next voyage <span className="muted">· one of each at most, used up when your ship sails</span></h4>
      <p className="works-stock">
        Your brew bag: {view.bag.length ? view.bag.map((id) => (
          <span key={id} className="works-bag-brew"><ThingIcon icon={brewIcon(id)} size={18} /><strong>{BREWS.find((b) => b.id === id)?.name}</strong></span>
        )) : <strong>empty</strong>}
        {bagBuff && <span className="muted"> · next voyage {bagBuff}</span>}
      </p>
      <ul className="workshop-list">
        {BREWS.map((b) => {
          const carried = view.bag.includes(b.id);
          const problem = brewProblem(b.id, view);
          return (
            <li key={b.id} className={carried ? "having" : ""} data-brew={b.id}>
              <ThingIcon icon={brewIcon(b.id)} size={36} />
              <span className="grow">
                <strong>{b.name}</strong> <span className="muted">· {perkText(b.buff)}</span>
                <br />
                <span className="muted small-note">{b.blurb}</span>
                <br />
                <CostChips cost={b.recipe} have={view.resources} />
              </span>
              <button className="small" disabled={d.busy || !!problem} title={problem ?? `Brew a ${b.name}`} onClick={() => void brew(b.id, b.name)}>{carried ? "In your bag" : "Brew"}</button>
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}

// ---------- the smithy ----------

export function SmithyKeeperPanel({ me, view, setView, reload, refresh, onSay, onDone }: {
  me: Me;
  view: SmithyView;
  setView(view: SmithyView): void;
  reload(): Promise<unknown>;
  refresh(): Promise<unknown>;
  onSay(text: string): void;
  onDone(): void;
}) {
  const c = me.character!;
  const d = useDealing("smithy", reload, refresh, onSay);
  const worn = useMemo(() => new Map(me.inventory.map(toOwned).filter((i) => i.equipped).map((i) => [i.slot, i])), [me.inventory]);

  const buy = (ware: KeeperWare) =>
    d.run(async () => {
      const res = await api.buyFromSmith(ware.key);
      setView(res);
      void refresh();
      return { text: `${res.got} is in your pack, for ${ware.price}g.`, tone: "good" };
    });
  const work = (id: number) =>
    d.run(async () => {
      const res = await api.smith(id);
      setView(res);
      // Gold and power changed on the character sheet too.
      void refresh();
      return { text: `The smith hands it back: ${res.worked}.${res.xp?.text ? ` ${res.xp.text}` : ""}`, tone: "good" };
    });

  return (
    <Frame shop="smithy" said={d.said} onDone={onDone} hold={<p className="works-stock">You hold: <RewardChips zeros gold={view.gold} resources={{ iron: view.resources.iron ?? 0, copper: view.resources.copper ?? 0 }} /></p>}>
      <h4 className="keeper-section">On the rack <span className="muted">· today's work, for gold · made for your class and level</span></h4>
      <ul className="workshop-list">
        {view.wares.map((w) => {
          if (w.goods.kind !== "item") return null;
          const item = w.goods.item;
          const open = d.haggling === w.key;
          return (
            <li key={w.key} className={`keeper-row ${w.left <= 0 ? "sold" : ""}`} data-ware={w.key}>
              <div className="keeper-line">
                <ItemTile item={item} locked={!!equipProblem(item, c.class_id, c.level)} />
                <span className="grow">
                  <strong style={{ color: RARITY_COLOR[item.rarity] }}>{itemName(item)}</strong> <VerdictTag verdict={compare(item, worn.get(item.slot) ?? null).verdict} />
                  <br />
                  <span className="muted small-note">{SLOT_LABEL[item.slot]}{item.power > 0 && ` · +${item.power} ${powerLabel(item).toLowerCase()}`}{bonusSummary(item) && ` · ${bonusSummary(item)}`}</span>
                  <br />
                  <Price list={w.list} price={w.price} /> <DealTag deal={w.deal} />
                </span>
                <span className="keeper-buttons">
                  <button className="small primary" disabled={d.busy || !!w.problem} title={w.problem ?? `Buy for ${w.price} gold`} onClick={() => void buy(w)}>{w.left <= 0 ? "Sold" : `Buy · ${w.price}g`}</button>
                  <HaggleButton entry={w.key} deal={w.deal} list={w.list} open={open} busy={d.busy} disabled={w.left <= 0} onOpen={d.setHaggling} />
                </span>
              </div>
              {open && <HaggleAsks list={w.list} chances={view.chances} busy={d.busy} onAsk={(ask) => void d.haggle(w.key, ask)} onCancel={() => d.setHaggling(null)} />}
            </li>
          );
        })}
      </ul>

      <h4 className="keeper-section">Work on your gear <span className="muted">· +1 power a step, up to +{SMITHY_MAX_STEPS} · worn or in your pack</span></h4>
      {view.items.length === 0 && <p className="muted">You have no weapons or armour with you.</p>}
      <ul className="workshop-list">
        {view.items.map((item) => {
          const shown = upgradedName(item.name, item.upgrades);
          const problem = smithyProblem(item, view);
          const verb = smithyWork(item) === "sharpen" ? "Sharpen" : "Reinforce";
          const key = workKey(item.id);
          const open = d.haggling === key;
          return (
            <li key={item.id} className="keeper-row" data-item={item.id}>
              <div className="keeper-line">
                <span className="thing-tile workshop-gear" style={{ borderColor: RARITY_COLOR[item.rarity] }}><Icon name={item.icon} color={RARITY_COLOR[item.rarity]} size={36} /></span>
                <span className="grow">
                  <strong>{shown}</strong> <span className="muted">· power {item.power}{item.equipped ? " · worn" : ""}</span>
                  <br />
                  <span className="muted small-note">
                    {item.cost ? <>{verb}, step {item.upgrades + 1} of {SMITHY_MAX_STEPS}: <CostChips cost={item.cost.resources} have={view.resources} gold={item.cost.gold} haveGold={view.gold} />{item.cost.gold < item.listGold && <> <s>{item.listGold}g</s></>}</> : "As good as the smith can make it."}
                  </span>
                  {item.cost && item.deal && <><br /><DealTag deal={item.deal} /></>}
                </span>
                <span className="keeper-buttons">
                  <button className="small primary" disabled={d.busy || !!problem} title={problem ?? `${verb} for ${amountsText(item.cost!.gold, item.cost!.resources)}`} onClick={() => void work(item.id)}>{item.cost ? `${verb} +1` : `+${SMITHY_MAX_STEPS}`}</button>
                  {item.cost && <HaggleButton entry={key} deal={item.deal} list={item.listGold} open={open} busy={d.busy} onOpen={d.setHaggling} />}
                </span>
              </div>
              {open && item.cost && <HaggleAsks list={item.listGold} chances={view.chances} busy={d.busy} onAsk={(ask) => void d.haggle(key, ask)} onCancel={() => d.setHaggling(null)} />}
            </li>
          );
        })}
      </ul>
    </Frame>
  );
}
