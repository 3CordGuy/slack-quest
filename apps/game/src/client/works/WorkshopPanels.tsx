// The galley, a workshop the crew can build at the Harbor, where the crew
// cooks into one larder their next ship sails with. (The apothecary and the
// smithy are walked into now, and dealt with in works/KeeperPanels.tsx.)
//
// What can be done is worked out here only to grey out buttons; the server
// checks every brew and every step again.

import { useEffect, useState } from "react";
import { BREWS, DISHES, FLASK_RECIPES, RARITY_COLOR, SMITHY_MAX_STEPS, THROWABLES, THROWABLE_KINDS, brewBuff, cookProblem, flaskProblem, larderText, brewProblem, smithyProblem, smithyWork, upgradedName, type Resources, type Throwable } from "@gantt-quest/world";
import { api, type ApothecaryView, type GalleyView, type SmithyView } from "../api";
import { DragPanel } from "../DragPanel";
import { CostChips, RewardChips, perkText } from "../hutDrops";
import { Icon } from "../items";
import { ThingIcon, brewIcon, dishIcon } from "../thingIcons";
import { label } from "../labels";
import { ITEM_ICON } from "../zone/actionIcons";
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

export function GalleyPanel({ onClose }: { onClose(): void }) {
  const [view, setView] = useState<GalleyView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api.galley().then(setView, (e: Error) => setError(e.message));
  }, []);
  const cook = async (id: string, name: string) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.cook(id);
      setView(res);
      setNotice(`${name} goes into the crew's larder.${res.xp?.text ? ` ${res.xp.text}` : ""}`);
    } catch (e) {
      setError((e as Error).message);
      api.galley().then(setView, () => {});
    } finally {
      setBusy(false);
    }
  };
  const stocked = view ? larderText(view.larder) : "";

  return (
    <Shell
      id="harbor.galley"
      title="The galley"
      intro="Cook for the crew's next ship. The larder is shared: anyone in the crew can cook into it, and the whole of it goes aboard when your crew's next ship sails."
      error={error}
      notice={notice}
      onClose={onClose}
    >
      {!view && !error && <p className="muted">Stirring the pot…</p>}
      {view && !view.inCrew && <p className="muted">Join a crew first: the galley cooks for a crew's ship.</p>}
      {view && view.inCrew && (
        <>
          <p className="works-stock">
            The crew's larder: {stocked ? DISHES.filter((d) => view.larder[d.id]).map((d) => (
              <span key={d.id} className="works-bag-brew"><ThingIcon icon={dishIcon(d.id)} size={18} /><strong>{view.larder[d.id]} {view.larder[d.id] === 1 ? d.name : d.plural}</strong></span>
            )) : <strong>empty</strong>}
            {stocked && <span className="muted"> · goes aboard the next ship</span>}
          </p>
          <p className="works-stock">You hold: <RewardChips zeros resources={{ bone: view.resources.bone ?? 0, herbs: view.resources.herbs ?? 0, fur: view.resources.fur ?? 0, mushrooms: view.resources.mushrooms ?? 0 }} /></p>
          <ul className="workshop-list">
            {DISHES.map((d) => {
              const held = view.larder[d.id] ?? 0;
              const problem = cookProblem(d.id, view);
              return (
                <li key={d.id} className={held >= d.cap ? "having" : ""} data-dish={d.id}>
                  <ThingIcon icon={dishIcon(d.id)} size={36} />
                  <span className="grow">
                    <strong>{d.name}</strong> <span className="muted">· {held}/{d.cap} in the larder</span>
                    <br />
                    <span className="muted small-note">{d.effect} {d.blurb}</span>
                    <br />
                    <CostChips cost={d.recipe} have={view.resources} />
                  </span>
                  <button className="small" disabled={busy || !!problem} title={problem ?? `Cook ${d.name}`} onClick={() => void cook(d.id, d.name)}>
                    {held >= d.cap ? "Larder full" : "Cook"}
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
