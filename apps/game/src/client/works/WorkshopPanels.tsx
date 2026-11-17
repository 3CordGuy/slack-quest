// The workshops the crew can build at the Harbor: the apothecary, where
// what is gathered is brewed into potions and flasks for the pack (to drink
// or throw out on a map) and into a bag carried on the next voyage; the
// smithy, where weapons are sharpened and armour reinforced; and the galley,
// where the crew cooks into one larder their next ship sails with.
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

export function ApothecaryPanel({ onClose, refresh }: { onClose(): void; refresh?(): Promise<unknown> }) {
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
  /** One more potion, flask or bomb for the pack. */
  const brewFlask = async (kind: Throwable) => {
    setBusy(true);
    setError(null);
    setNotice(null);
    try {
      const res = await api.brewFlask(kind);
      setView(res);
      setNotice(`${THROWABLES[kind].name}: one more in your pack, ${res.carried[kind] ?? 1} in all.${res.xp?.text ? ` ${res.xp.text}` : ""}`);
      // The bag and the bar count them too.
      void refresh?.();
    } catch (e) {
      setError((e as Error).message);
      api.apothecary().then(setView, () => {});
    } finally {
      setBusy(false);
    }
  };
  const bagBuff = perkText(brewBuff(view?.bag));

  return (
    <Shell id="harbor.apothecary" title="The apothecary" intro="Brew what you have gathered into potions and flasks for your pack, to drink or throw out on a map, or into something for your next voyage." error={error} notice={notice} onClose={onClose}>
      {!view && !error && <p className="muted">Grinding, steeping…</p>}
      {view && (
        <>
          <p className="works-stock">You hold: <RewardChips zeros resources={{ herbs: view.resources.herbs ?? 0, mushrooms: view.resources.mushrooms ?? 0, bone: view.resources.bone ?? 0, wood: view.resources.wood ?? 0, copper: view.resources.copper ?? 0, fur: view.resources.fur ?? 0, slime: view.resources.slime ?? 0 }} /></p>
          <p className="works-stock"><strong>For your pack</strong> <span className="muted">· kept until you use them, as many as you can carry</span></p>
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
                    <span className="muted small-note">{def.blurb}</span>
                    <br />
                    <CostChips cost={FLASK_RECIPES[kind]} have={view.resources} />
                  </span>
                  <button className="small" disabled={busy || !!problem} title={problem ?? `Brew one more ${def.name.toLowerCase()}`} onClick={() => void brewFlask(kind)}>Brew</button>
                </li>
              );
            })}
          </ul>
          <p className="works-stock"><strong>For your next voyage</strong> <span className="muted">· one of each at most, used up when your ship sails</span></p>
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
