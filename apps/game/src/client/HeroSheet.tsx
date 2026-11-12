// A hero's sheet, read-only: what opens on hovering over a hero (with a
// mouse) or clicking them (anywhere, and the only way on a phone). Their
// level, HP, focus and XP, the five stats with what gear adds, what they wear
// on the paper doll, their weapon's abilities, the class passive and what
// their hut gives them. Works for anyone in your crew or on your voyage, and
// for yourself.

import { useCallback, useEffect, useRef, useState } from "react";
import {
  ABILITIES,
  HERO_CLASSES,
  RARITY_COLOR,
  SLOT_ICON,
  SLOT_LABEL,
  STAT_BLURB,
  STAT_KEYS,
  STAT_LABEL,
  WEAPONS,
  armorBlock,
  healthBand,
  maxFocusFor,
  maxHpFor,
  outfitOf,
  statPct,
  xpToNext,
  type ItemDef,
  type PublicHero,
  type Slot,
} from "@gantt-quest/world";
import type { StatKey } from "@gantt-quest/core";
import { api } from "./api";
import { perkText } from "./hutDrops";
import { Icon, ItemDetail, ItemTile } from "./items";
import { blurb, itemName, label } from "./labels";
import { spriteDataUrl } from "./render/sprites";
import "./heroSheet.css";

const LEFT: Slot[] = ["helmet", "body", "amulet", "ring"];
const RIGHT: Slot[] = ["main_hand", "off_hand", "legs", "boots"];
/** A sheet fetched this recently is shown as it is; older ones are fetched again (gear changes). */
const FRESH_MS = 20_000;
/** A mouse resting on a hero this long opens their sheet; passing over does not. */
const HOVER_MS = 250;

/** On a voyage, how they stand right now. Off one, everyone is rested: full HP and focus. */
export interface LiveVitals {
  hp: number;
  maxHp: number;
  focus: number;
  maxFocus: number;
}

const cache = new Map<string, { at: number; hero: PublicHero }>();

function useHero(id: string | null): { hero: PublicHero | null; error: string | null } {
  const [, bump] = useState(0);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    setError(null);
    if (!id) return;
    const hit = cache.get(id);
    if (hit && Date.now() - hit.at < FRESH_MS) return;
    let live = true;
    api.hero(id).then(
      ({ hero }) => {
        cache.set(id, { at: Date.now(), hero });
        if (live) bump((n) => n + 1);
      },
      (err: Error) => live && setError(err.message),
    );
    return () => {
      live = false;
    };
  }, [id]);
  return { hero: id ? (cache.get(id)?.hero ?? null) : null, error };
}

/**
 * Which hero's sheet is open, and the renderer callbacks that open it. A click
 * pins it open (another click on them, or Close, shuts it); with a mouse,
 * resting on a hero shows it until the pointer moves off.
 */
export function useHeroSheet(isHero: (id: string) => boolean = () => true) {
  const [pinned, setPinned] = useState<string | null>(null);
  const [hovered, setHovered] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const check = useRef(isHero);
  check.current = isHero;
  // A touch screen has no hover: a tap is a click, and the sheet waits for it.
  const canHover = useRef(typeof matchMedia === "function" && matchMedia("(hover: hover) and (pointer: fine)").matches);

  const onHeroClick = useCallback((id: string) => {
    if (!check.current(id)) return false;
    setPinned((p) => (p === id ? null : id));
    return true;
  }, []);
  const onHeroHover = useCallback((id: string | null) => {
    clearTimeout(timer.current);
    if (!canHover.current) return;
    if (id === null || !check.current(id)) {
      setHovered(null);
      return;
    }
    timer.current = setTimeout(() => setHovered(id), HOVER_MS);
  }, []);
  useEffect(() => () => clearTimeout(timer.current), []);
  const close = useCallback(() => setPinned(null), []);
  return { open: pinned ?? hovered, pinned: pinned !== null, onHeroClick, onHeroHover, close };
}

interface Props {
  id: string;
  you: string;
  pinned: boolean;
  onClose(): void;
  /** On a voyage: their HP and focus as they are now. */
  live?: LiveVitals;
}

export function HeroSheet({ id, you, pinned, onClose, live }: Props) {
  const { hero, error } = useHero(id);
  const [picked, setPicked] = useState<Slot | null>(null);
  useEffect(() => setPicked(null), [id]);
  useEffect(() => {
    if (!pinned) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [pinned, onClose]);

  if (!hero) {
    return (
      <aside className={`hero-card panel ${pinned ? "pinned" : ""}`} aria-label="Hero">
        <p className="muted">{error ?? "Looking them over…"}</p>
        {pinned && <button className="small" onClick={onClose}>Close</button>}
      </aside>
    );
  }

  const worn = new Map<Slot, ItemDef>(hero.gear.map((g) => [g.slot, g]));
  const total = (k: StatKey) => hero.base[k] + (hero.bonus[k] ?? 0);
  const stats = { str: total("str"), int_stat: total("int_stat"), vit: total("vit"), agi: total("agi"), dex: total("dex") };
  const maxHp = live?.maxHp ?? maxHpFor(stats, hero.level);
  const hp = live?.hp ?? maxHp;
  const maxFocus = live?.maxFocus ?? maxFocusFor(hero.level);
  const focus = live?.focus ?? maxFocus;
  const need = xpToNext(hero.level);
  const cls = HERO_CLASSES.find((c) => c.id === hero.classId);
  const weapon = worn.get("main_hand");
  const abilities = weapon?.kind === "weapon" ? (WEAPONS[weapon.ref]?.abilities ?? []) : [];
  const perks = perkText(hero.hutPerks);
  const pickedItem = picked ? worn.get(picked) : undefined;

  const slot = (s: Slot) => {
    const item = worn.get(s);
    return (
      <div key={s} className="hs-slot">
        {item ? (
          <ItemTile item={item} selected={picked === s} onClick={pinned ? () => setPicked(picked === s ? null : s) : undefined} />
        ) : (
          <span className="tile empty" title={`${SLOT_LABEL[s]}: empty`}><Icon name={SLOT_ICON[s]} color="#4a4570" size={36} silhouette /></span>
        )}
      </div>
    );
  };

  return (
    <aside className={`hero-card panel ${pinned ? "pinned" : ""}`} role={pinned ? "dialog" : undefined} aria-label={`${hero.name}'s sheet`}>
      <header className="hs-head">
        <img className="hs-face" src={spriteDataUrl(hero.classId, outfitOf(hero.gear))} alt="" />
        <div className="hs-title">
          <strong>{hero.name}{hero.id === you && <span className="muted"> (you)</span>}</strong>
          <span className="muted">{label("class", hero.classId)} · <span className="hs-level">Lv {hero.level}</span></span>
        </div>
        {pinned && <button className="small" onClick={onClose} aria-label="Close">✕</button>}
      </header>

      <div className="hs-bars">
        <div className="bar" title={live ? "Hit points on this voyage" : "Rested: every voyage starts at full HP"}>
          <div className={`bar-fill hs-hp ${healthBand(hp / maxHp)}`} style={{ width: `${(100 * hp) / maxHp}%` }} />
          <span>{hp} / {maxHp} HP</span>
        </div>
        <div className="bar" title={live ? "Focus left on this voyage" : "Rested: every voyage starts with full focus"}>
          <div className="bar-fill hs-focus" style={{ width: `${(100 * focus) / Math.max(1, maxFocus)}%` }} />
          <span>{focus} / {maxFocus} focus</span>
        </div>
        <div className="bar" title={`${need - hero.xp} XP to level ${hero.level + 1}`}>
          <div className="bar-fill xp" style={{ width: `${Math.min(100, (100 * hero.xp) / need)}%` }} />
          <span>{hero.xp} / {need} XP</span>
        </div>
      </div>

      <div className="hs-doll">
        <div className="hs-col">{LEFT.map(slot)}</div>
        <div className="hs-numbers">
          <div title="Added to the damage of every ability"><strong>+{hero.weaponPower}</strong><span>Power</span></div>
          <div title={`Each enemy hit is reduced by ${armorBlock(hero.armor)}, up to half the hit`}><strong>{hero.armor}</strong><span>Armor</span></div>
        </div>
        <div className="hs-col">{RIGHT.map(slot)}</div>
      </div>
      {pickedItem && <ItemDetail item={pickedItem} equipped classId={hero.classId} level={hero.level} />}
      {!pinned && <p className="muted hs-hint">Click them to keep this open.</p>}

      <div className="hs-stats">
        {STAT_KEYS.map((k) => (
          <div key={k} className="hs-stat" title={STAT_BLURB[k]}>
            <span>{STAT_LABEL[k]}</span>
            <strong>{total(k)}</strong>
            <span className={hero.bonus[k] ? "good" : "muted"}>{hero.bonus[k] ? `(${hero.base[k]} +${hero.bonus[k]})` : ""}</span>
            <span className="muted">{statPct(total(k))}%</span>
          </div>
        ))}
      </div>

      {weapon && (
        <section>
          <h4 style={{ color: RARITY_COLOR[weapon.rarity] }}>{itemName(weapon)}</h4>
          {abilities.length > 0 ? (
            <ul className="abilities">
              {abilities.map((a) => ABILITIES[a] && (
                <li key={a}><strong>{label("ability", a)}</strong> <span className="muted">{ABILITIES[a].rolls} × {STAT_LABEL[ABILITIES[a].stat]} · {blurb("ability", a)}</span></li>
              ))}
            </ul>
          ) : <p className="muted">No abilities.</p>}
        </section>
      )}
      {cls?.passive && (
        <section>
          <h4>Passive</h4>
          <p className="muted">{cls.passive}</p>
        </section>
      )}
      {perks && (
        <section>
          <h4>Hut</h4>
          <p className="muted">{perks} on each voyage</p>
        </section>
      )}
    </aside>
  );
}
