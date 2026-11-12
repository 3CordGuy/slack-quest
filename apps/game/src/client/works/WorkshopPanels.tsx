// The two workshops the crew can build at the Harbor: the apothecary, where
// herbs and mushrooms are brewed into a bag carried on the next voyage, and
// the smithy, where weapons are sharpened and armour reinforced.
//
// What can be done is worked out here only to grey out buttons; the server
// checks every brew and every step again.

import { useEffect, useState } from "react";
import { BREWS, SMITHY_MAX_STEPS, brewBuff, brewProblem, recipeText, smithyProblem, smithyWork, upgradedName, type Resources } from "@gantt-quest/world";
import { api, type ApothecaryView, type SmithyView } from "../api";
import { DragPanel } from "../DragPanel";
import { perkText } from "../hutDrops";
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
      setView(await api.brew(id));
      setNotice(`A ${name} goes into your bag.`);
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
            Your brew bag: <strong>{view.bag.length ? view.bag.map((id) => BREWS.find((b) => b.id === id)?.name).join(", ") : "empty"}</strong>
            {bagBuff && <span className="muted"> · next voyage {bagBuff}</span>}
          </p>
          <p className="works-stock">You hold: <strong>{amountsText(0, { herbs: view.resources.herbs ?? 0, mushrooms: view.resources.mushrooms ?? 0, bone: view.resources.bone ?? 0 })}</strong></p>
          <ul className="workshop-list">
            {BREWS.map((b) => {
              const carried = view.bag.includes(b.id);
              const problem = brewProblem(b.id, view);
              return (
                <li key={b.id} className={carried ? "having" : ""} data-brew={b.id}>
                  <span>
                    <strong>{b.name}</strong> <span className="muted">· {perkText(b.buff)}</span>
                    <br />
                    <span className="muted small-note">{b.blurb} Takes {recipeText(b.recipe)}.</span>
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
      setNotice(`The smith hands it back: ${res.worked}.`);
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
          <p className="works-stock">You hold: <strong>{amountsText(view.gold, { iron: view.resources.iron ?? 0, copper: view.resources.copper ?? 0 })}</strong></p>
          {view.items.length === 0 && <p className="muted">You have no weapons or armour with you.</p>}
          <ul className="workshop-list">
            {view.items.map((item) => {
              const shown = { ...item, name: upgradedName(item.name, item.upgrades) };
              const problem = smithyProblem(item, view);
              const verb = smithyWork(item) === "sharpen" ? "Sharpen" : "Reinforce";
              return (
                <li key={item.id} data-item={item.id}>
                  <span>
                    <strong>{shown.name}</strong> <span className="muted">· power {item.power}{item.equipped ? " · worn" : ""}</span>
                    <br />
                    <span className="muted small-note">
                      {item.cost ? `Step ${item.upgrades + 1} of ${SMITHY_MAX_STEPS}: ${amountsText(item.cost.gold, item.cost.resources)}` : "As good as the smith can make it."}
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
