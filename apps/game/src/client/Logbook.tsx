// The logbook: your hero, written up in an open book. The left-hand page is
// who they are (level, experience, what their gear adds up to); the
// right-hand page turns with the ribbons down its edge: Stats, where points
// are spent; Traits, one of two picked at each trait level, for keeps; and
// Skills, what the weapon in hand can do. A fourth ribbon opens the Catch Book.

import { useEffect, useMemo, useState } from "react";
import {
  ABILITIES,
  HERO_CLASSES,
  STAT_BLURB,
  STAT_KEYS,
  STAT_LABEL,
  TRAIT_LEVELS,
  abilitiesFor,
  armorBlock,
  loadoutOf,
  maxFocusFor,
  maxHpFor,
  outfitOf,
  parseTraits,
  pendingTraitTiers,
  statPct,
  traitsFor,
  xpToNext,
} from "@gantt-quest/world";
import { api, type Me, type StatKey } from "./api";
import { CatchBookPanel } from "./CatchBook";
import { useAct } from "./Harbor";
import { toOwned } from "./items";
import { blurb, label } from "./labels";
import { spriteDataUrl, withLook } from "./render/sprites";
import "./book.css";

type Page = "stats" | "traits" | "skills";

interface Props {
  me: Me;
  refresh(): Promise<unknown>;
  onClose(): void;
  /** Opened during a voyage: the hero cannot be re-rolled or leave the crew from here. */
  onIsland?: boolean;
}

export function Logbook({ me, refresh, onClose, onIsland = false }: Props) {
  const c = me.character!;
  const { busy, error, act } = useAct(refresh);
  const picked = parseTraits(c.traits);
  const waiting = pendingTraitTiers(c.class_id, c.level, picked);
  const [page, setPage] = useState<Page>(waiting.length > 0 && c.unspent_points === 0 ? "traits" : "stats");
  const [catches, setCatches] = useState(false);

  useEffect(() => {
    const key = (e: KeyboardEvent) => e.key === "Escape" && !catches && onClose();
    addEventListener("keydown", key);
    return () => removeEventListener("keydown", key);
  }, [onClose, catches]);

  const worn = useMemo(() => me.inventory.map(toOwned).filter((i) => i.equipped), [me.inventory]);
  const loadout = loadoutOf(worn);
  const cls = HERO_CLASSES.find((k) => k.id === c.class_id);
  const total = (k: StatKey) => c[k] + (loadout.bonus[k] ?? 0);
  const stats = { str: total("str"), int_stat: total("int_stat"), vit: total("vit"), agi: total("agi"), dex: total("dex") };
  const weapon = worn.find((i) => i.slot === "main_hand");
  const abilities = abilitiesFor(weapon?.ref);
  const next = xpToNext(c.level);

  return (
    <div className="overlay book-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="book" role="dialog" aria-label="Logbook">
        <button className="book-close" aria-label="Close" title="Close (Esc)" onClick={onClose}>×</button>
        {(["tl", "tr", "bl", "br"] as const).map((c) => <span key={c} className={`book-corner ${c}`} aria-hidden />)}
        <span className="book-marker" aria-hidden />

        <section className="book-page left">
          <h2>{c.name}</h2>
          <p className="book-sub">{c.title ? <>{c.title} · </> : null}{label("class", c.class_id)} · Level {c.level}</p>
          <div className="book-portrait"><img src={spriteDataUrl(c.class_id, withLook(outfitOf(worn), c.appearance), true)} alt="" /></div>
          <div className="book-xp" title={`${c.xp} of ${next} XP`}>
            <div style={{ width: `${(100 * c.xp) / next}%` }} />
            <span>{c.xp} / {next} experience</span>
          </div>
          {me.harborXp && (
            <p className="book-note" title="Gathering, the pub's tables, the sparring ring, crafting, the Apothecary, the Smithy and crew projects each give a few XP. Voyages are not capped.">
              From Harbor pastimes today: {me.harborXp.cap - me.harborXp.left} of {me.harborXp.cap}.
            </p>
          )}
          <dl className="book-totals">
            <div title="Hit points at the start of a voyage"><dt>Hit points</dt><dd>{maxHpFor(stats, c.level)}</dd></div>
            <div title={`Each enemy hit is reduced by ${armorBlock(loadout.armor)}, up to half the hit`}><dt>Armor</dt><dd>{loadout.armor} <small>blocks {armorBlock(loadout.armor)}</small></dd></div>
            <div title="Added to the damage of every ability"><dt>Weapon power</dt><dd>+{loadout.weaponPower}</dd></div>
            <div title="Focus points at the start of a voyage"><dt>Focus</dt><dd>{maxFocusFor(c.level)}</dd></div>
          </dl>
          {cls && <p className="book-note"><em>{cls.blurb}</em></p>}
          {error && <p className="book-error">{error}</p>}
          {!onIsland && (
            <p className="book-foot">
              <button className="book-link" disabled={busy} onClick={() => confirm("Re-roll? This discards the character and all its gear.") && void act(() => api.reroll())}>Re-roll character</button>
              <button className="book-link" disabled={busy} onClick={() => confirm("Leave this crew? You can rejoin with its invite code.") && void act(() => api.leaveCrew())}>Leave crew</button>
            </p>
          )}
        </section>

        <section className="book-page right">
          {page === "stats" && (
            <>
              <h3>Stats {c.unspent_points > 0 && <span className="book-new">{c.unspent_points} point{c.unspent_points > 1 ? "s" : ""} to spend</span>}</h3>
              {STAT_KEYS.map((k) => (
                <div key={k} className="book-stat">
                  <strong>{STAT_LABEL[k]}</strong>
                  <span className="book-stat-n">{total(k)}{loadout.bonus[k] ? <small> (+{loadout.bonus[k]} gear)</small> : null}</span>
                  <span className="book-stat-pct">{statPct(total(k))}% a roll</span>
                  {c.unspent_points > 0 && <button className="book-plus" disabled={busy} title={`Spend a point on ${STAT_LABEL[k]}`} onClick={() => act(() => api.spend(k))}>+</button>}
                  <p>{STAT_BLURB[k]}</p>
                </div>
              ))}
            </>
          )}
          {page === "traits" && (
            <>
              <h3>Traits {waiting.length > 0 && <span className="book-new">a pick is waiting</span>}</h3>
              {TRAIT_LEVELS.map((at, i) => {
                const tier = (i + 1) as 1 | 2;
                const open = waiting.includes(tier);
                const locked = c.level < at;
                return (
                  <div key={tier} className={`book-tier ${locked ? "locked" : ""}`}>
                    <p className="book-tier-at">Level {at}{locked ? " · not yet" : open ? " · pick one, for keeps" : ""}</p>
                    <div className="book-traits">
                      {traitsFor(c.class_id).filter((t) => t.tier === tier).map((t) => {
                        const mine = picked.includes(t.id);
                        return (
                          <button key={t.id} className={`book-trait ${mine ? "mine" : ""} ${!open && !mine ? "passed" : ""}`} disabled={!open || busy} onClick={() => act(() => api.pickTrait(t.id))}>
                            <strong>{t.name}</strong>
                            <span>{t.blurb}</span>
                          </button>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </>
          )}
          {page === "skills" && (
            <>
              <h3>Skills</h3>
              <p className="book-note">{weapon ? <>What your <strong>{weapon.name}</strong> can do in a fight. A different weapon brings different skills.</> : "Nothing in hand: all you can do in a fight is punch. Put a weapon in your main hand for its skills."}</p>
              {abilities.map((id, i) => {
                const a = ABILITIES[id];
                return (
                  <div key={id} className="book-skill">
                    <span className="book-skill-n">{i + 1}</span>
                    <div>
                      <strong>{label("ability", id)}</strong>
                      <small> {a.rolls} × {STAT_LABEL[a.stat]} · {statPct(total(a.stat))}% a roll</small>
                      <p>{blurb("ability", id)}</p>
                    </div>
                  </div>
                );
              })}
              {cls?.passive && <div className="book-skill"><span className="book-skill-n">✦</span><div><strong>Passive</strong><small> always on</small><p>{cls.passive}</p></div></div>}
            </>
          )}
        </section>

        <nav className="book-ribbons" aria-label="Pages">
          {([["stats", "Stats", c.unspent_points > 0], ["traits", "Traits", waiting.length > 0], ["skills", "Skills", false]] as const).map(([id, name, news]) => (
            <button key={id} className={`ribbon ${id} ${page === id ? "on" : ""}`} aria-pressed={page === id} onClick={() => setPage(id)}>
              {name}{news && <i aria-label="something waiting" />}
            </button>
          ))}
          {!onIsland && <button className="ribbon catch" title="Every kind you have caught, page by page" onClick={() => setCatches(true)}>Catch Book</button>}
        </nav>
      </div>
      {catches && <CatchBookPanel onClose={() => setCatches(false)} />}
    </div>
  );
}
