// The two workshops the crew can build at the Harbor: the apothecary, where
// herbs and mushrooms are brewed into a bag carried on the next voyage, and
// the smithy, where weapons are sharpened and armour reinforced.
//
// What can be done is worked out here only to grey out buttons; the server
// checks every brew and every step again.

import { useEffect, useState } from "react";
import { BREWS, RARITY_COLOR, SMITHY_MAX_STEPS, brewBuff, brewProblem, smithyProblem, smithyWork, upgradedName, type Resources } from "@gantt-quest/world";
import { api, type ApothecaryView, type SmithyView } from "../api";
import { DragPanel } from "../DragPanel";
import { CostChips, RewardChips, perkText } from "../hutDrops";
import { Icon } from "../items";
import { ThingIcon, brewIcon } from "../thingIcons";
import { label } from "../labels";
import "./works.css";

/** "3 herbs, 1 bone", with the resources' own (possibly renamed) labels. */
const amountsText = (gold: number, r: Resources) =>
  [gold > 0 ? `${gold} gold` : "", ...Object.entries(r).filter(([, n]) => n).map(([k, n]) => `${n} ${label("resource", k).toLowerCase()}`)].filter(Boolean).join(", ");

function Shell({ id, title, intro, error, notice, onClose, children }: { id: string; title: string; intro: string; error: string | null; notice: string | null; onClose(): void; children: React.ReactNode }) {
  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id={id} title={title} compact className="panel works-panel workshop-panel" role="dialog" aria-label={title}>
        <header className="works-head">
          <h2>{title}</h2>
          <span className="spacer" />
          <button className="small" onClick={onClose}>Close</button>
        </header>
        <p className="muted">{intro}</p>
        {error && <p className="bad" role="alert">{error}</p>}
        {notice && <p className="good" role="status">{notice}</p>}
        {children}
      </DragPanel>
    </div>
  );
}

export function ApothecaryPanel({ onClose }: { onClose(): void }) {
  const [view, setView] = useState<ApothecaryView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.apothecary().then(setView, (e: Error) => setError(e.message));
  }, []);
  const brew = async (id: string, name: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.brew(id);
      setView(res);
      setNotice(`A ${name} goes into your bag.${res.xp?.text ? ` ${res.xp.text}` : ""}`);
    } catch (e) {
      setError((e as Error).message);
      api.apothecary().then(setView, () => {});
    } finally {
      setBusy(false);
    }
  };
  const bagBuff = perkText(brewBuff(view?.bag));

  return (
    <Shell id="harbor.apothecary" title="The apothecary" intro="Brew herbs and mushrooms into something for your next voyage. You carry one of each at most, and they are used up when your ship sails." error={error} notice={notice} onClose={onClose}>
      {!view && !error && <p className="muted">Grinding, steeping…</p>}
      {view && (
        <>
          <p className="works-stock">
            Your brew bag: {view.bag.length ? view.bag.map((id) => (
              <span key={id} className="works-bag-brew"><ThingIcon icon={brewIcon(id)} size={18} /><strong>{BREWS.find((b) => b.id === id)?.name}</strong></span>
            )) : <strong>empty</strong>}
            {bagBuff && <span className="muted"> · next voyage {bagBuff}</span>}
          </p>
          <p className="works-stock">You hold: <RewardChips zeros resources={{ herbs: view.resources.herbs ?? 0, mushrooms: view.resources.mushrooms ?? 0, bone: view.resources.bone ?? 0 }} /></p>
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
                  <button className="small" disabled={busy || !!problem} title={problem ?? `Brew a ${b.name}`} onClick={() => void brew(b.id, b.name)}>
                    {carried ? "In your bag" : "Brew"}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Shell>
  );
}

export function SmithyPanel({ onClose, refresh }: { onClose(): void; refresh(): Promise<unknown> }) {
  const [view, setView] = useState<SmithyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.smithy().then(setView, (e: Error) => setError(e.message));
  }, []);
  const work = async (id: number) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.smith(id);
      setView(res);
      setNotice(`The smith hands it back: ${res.worked}.${res.xp?.text ? ` ${res.xp.text}` : ""}`);
      // Gold and power changed on the character sheet too.
      void refresh();
    } catch (e) {
      setError((e as Error).message);
      api.smithy().then(setView, () => {});
    } finally {
      setBusy(false);
    }
  };

  return (
    <Shell id="harbor.smithy" title="The smithy" intro={`Sharpen a weapon or reinforce armour: +1 power a step, up to +${SMITHY_MAX_STEPS}. Each step costs more than the last. Bring the gear with you, worn or in your pack.`} error={error} notice={notice} onClose={onClose}>
      {!view && !error && <p className="muted">Stoking the forge…</p>}
      {view && (
        <>
          <p className="works-stock">You hold: <RewardChips zeros gold={view.gold} resources={{ iron: view.resources.iron ?? 0, copper: view.resources.copper ?? 0 }} /></p>
          {view.items.length === 0 && <p className="muted">You have no weapons or armour with you.</p>}
          <ul className="workshop-list">
            {view.items.map((item) => {
              const shown = { ...item, name: upgradedName(item.name, item.upgrades) };
              const problem = smithyProblem(item, view);
              const verb = smithyWork(item) === "sharpen" ? "Sharpen" : "Reinforce";
              return (
                <li key={item.id} data-item={item.id}>
                  <span className="thing-tile workshop-gear" style={{ borderColor: RARITY_COLOR[item.rarity] }}><Icon name={item.icon} color={RARITY_COLOR[item.rarity]} size={36} /></span>
                  <span className="grow">
                    <strong>{shown.name}</strong> <span className="muted">· power {item.power}{item.equipped ? " · worn" : ""}</span>
                    <br />
                    <span className="muted small-note">
                      {item.cost ? <>Step {item.upgrades + 1} of {SMITHY_MAX_STEPS}: <CostChips cost={item.cost.resources} have={view.resources} gold={item.cost.gold} haveGold={view.gold} /></> : "As good as the smith can make it."}
                    </span>
                  </span>
                  <button className="small" disabled={busy || !!problem} title={problem ?? `${verb} for ${amountsText(item.cost!.gold, item.cost!.resources)}`} onClick={() => void work(item.id)}>
                    {item.cost ? `${verb} +1` : `+${SMITHY_MAX_STEPS}`}
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </Shell>
  );
}
