// The inventory: a paper doll of eight equipment slots around the hero, the
// pack beside it, and a detail panel that compares any item against what is
// worn. Drag an item onto the doll to equip it, or back to the pack to take
// it off. Stat points are spent here too.

import { useMemo, useState, type DragEvent } from "react";
import {
  HERO_CLASSES,
  SLOTS,
  SLOT_ICON,
  SLOT_LABEL,
  STAT_KEYS,
  STAT_LABEL,
  armorBlock,
  equipProblem,
  loadoutOf,
  maxFocusFor,
  maxHpFor,
  rarityIndex,
  sellPrice,
  statPct,
  xpToNext,
  type Slot,
} from "@gantt-quest/world";
import { api, type Me, type StatKey } from "./api";
import { useAct } from "./Harbor";
import { Icon, ItemDetail, ItemTile, toOwned, type OwnedItem } from "./items";
import { spriteDataUrl } from "./render/sprites";

const LEFT: Slot[] = ["helmet", "body", "amulet", "ring"];
const RIGHT: Slot[] = ["main_hand", "off_hand", "legs", "boots"];
const FILTERS = [
  { id: "all", label: "All", test: (_: OwnedItem) => true },
  { id: "weapon", label: "Weapons", test: (i: OwnedItem) => i.kind === "weapon" },
  { id: "armor", label: "Armor", test: (i: OwnedItem) => i.kind === "armor" },
  { id: "trinket", label: "Trinkets", test: (i: OwnedItem) => i.kind === "trinket" },
] as const;
const SORTS = {
  Type: (a: OwnedItem, b: OwnedItem) => SLOTS.indexOf(a.slot) - SLOTS.indexOf(b.slot) || rarityIndex(b.rarity) - rarityIndex(a.rarity),
  Rarity: (a: OwnedItem, b: OwnedItem) => rarityIndex(b.rarity) - rarityIndex(a.rarity) || b.power - a.power,
  Power: (a: OwnedItem, b: OwnedItem) => b.power - a.power || rarityIndex(b.rarity) - rarityIndex(a.rarity),
  Level: (a: OwnedItem, b: OwnedItem) => b.levelReq - a.levelReq || rarityIndex(b.rarity) - rarityIndex(a.rarity),
};
type SortKey = keyof typeof SORTS;

const DRAG_TYPE = "application/x-gq-item";

export function InventoryScreen({ me, refresh, onClose }: { me: Me; refresh(): Promise<unknown>; onClose(): void }) {
  const c = me.character!;
  const { busy, error, act } = useAct(refresh);
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const [slotHint, setSlotHint] = useState<Slot | null>(null);
  const [filter, setFilter] = useState<(typeof FILTERS)[number]["id"]>("all");
  const [sort, setSort] = useState<SortKey>("Type");
  const [over, setOver] = useState<string | null>(null);

  const items = useMemo(() => me.inventory.map(toOwned), [me.inventory]);
  const worn = useMemo(() => new Map(items.filter((i) => i.equipped).map((i) => [i.slot, i])), [items]);
  const pack = useMemo(
    () => items.filter((i) => !i.equipped && FILTERS.find((f) => f.id === filter)!.test(i)).sort(SORTS[sort]),
    [items, filter, sort],
  );
  const selected = items.find((i) => i.id === selectedId) ?? null;
  const loadout = loadoutOf([...worn.values()]);
  const cls = HERO_CLASSES.find((k) => k.id === c.class_id);
  const total = (k: StatKey) => c[k] + (loadout.bonus[k] ?? 0);
  const stats = { str: total("str"), int_stat: total("int_stat"), vit: total("vit"), agi: total("agi"), dex: total("dex") };

  const equip = (id: number) => act(() => api.equip(id));
  const unequip = (id: number) => act(() => api.unequip(id));
  const dragStart = (item: OwnedItem) => (e: DragEvent) => {
    e.dataTransfer.setData(DRAG_TYPE, String(item.id));
    e.dataTransfer.effectAllowed = "move";
    setSelectedId(item.id);
  };
  const dropTarget = (key: string, onDropId: (id: number) => void) => ({
    onDragOver: (e: DragEvent) => {
      if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
      e.preventDefault();
      setOver(key);
    },
    onDragLeave: () => setOver((o) => (o === key ? null : o)),
    onDrop: (e: DragEvent) => {
      e.preventDefault();
      setOver(null);
      const id = Number(e.dataTransfer.getData(DRAG_TYPE));
      if (id) onDropId(id);
    },
  });

  const slotCell = (slot: Slot) => {
    const item = worn.get(slot);
    return (
      <div
        key={slot}
        className={`slot-cell ${over === slot ? "over" : ""} ${slotHint === slot ? "hint" : ""}`}
        // The server puts an item in the slot it belongs to, so any doll slot accepts a drop.
        {...dropTarget(slot, (id) => void equip(id))}
      >
        {item ? (
          <ItemTile item={item} selected={selectedId === item.id} onClick={() => { setSelectedId(item.id); setSlotHint(null); }} onDragStart={dragStart(item)} />
        ) : (
          <button className="tile empty" title={`${SLOT_LABEL[slot]}: empty`} onClick={() => { setSlotHint(slotHint === slot ? null : slot); setSelectedId(null); }}>
            <Icon name={SLOT_ICON[slot]} color="#4a4570" size={34} />
          </button>
        )}
        <span className="slot-name">{SLOT_LABEL[slot]}</span>
      </div>
    );
  };

  return (
    <div className="overlay inv-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="inv panel" role="dialog" aria-label="Inventory">
        <header className="inv-head">
          <h2>{c.name} <span className="muted">· {cls?.name} · Level {c.level}</span></h2>
          <span className="spacer" />
          <span className="gold"><Icon name="cash" color="#ffd23f" size={18} /> {c.gold} gold</span>
          <button onClick={onClose}>Close</button>
        </header>
        {error && <div className="banner error">{error}</div>}

        <div className="inv-body">
          <section className="inv-left">
            <div className="doll">
              <div className="doll-col">{LEFT.map(slotCell)}</div>
              <div className="figure"><img src={spriteDataUrl(c.class_id)} alt="" /></div>
              <div className="doll-col">{RIGHT.map(slotCell)}</div>
            </div>
            <p className="muted hint-line">
              {slotHint ? `Drag or click a glowing item to wear it as ${SLOT_LABEL[slotHint].toLowerCase()}.` : "Drag items onto the figure to equip, or back to the pack to take them off."}
            </p>

            <div className="bar" title={`${c.xp} / ${xpToNext(c.level)} XP`}>
              <div className="bar-fill xp" style={{ width: `${(100 * c.xp) / xpToNext(c.level)}%` }} />
              <span>{c.xp} / {xpToNext(c.level)} XP</span>
            </div>
            <div className="totals">
              <div title="Hit points at the start of a voyage"><strong>{maxHpFor(stats, c.level)}</strong><span>Max HP</span></div>
              <div title={`Each enemy hit is reduced by ${armorBlock(loadout.armor)}, up to half the hit`}><strong>{loadout.armor}</strong><span>Armor · blocks {armorBlock(loadout.armor)}</span></div>
              <div title="Added to the damage of every ability"><strong>+{loadout.weaponPower}</strong><span>Weapon power</span></div>
              <div title="Focus points at the start of a voyage"><strong>{maxFocusFor(c.level)}</strong><span>Focus</span></div>
            </div>

            <div className="stats">
              {c.unspent_points > 0 && <p className="good">{c.unspent_points} stat point{c.unspent_points > 1 ? "s" : ""} to spend</p>}
              {STAT_KEYS.map((k) => (
                <div key={k} className="stat-row">
                  <span className="stat-name">{STAT_LABEL[k]}</span>
                  <span className="stat-value">{total(k)}</span>
                  <span className={loadout.bonus[k] ? "good" : "muted"}>{loadout.bonus[k] ? `+${loadout.bonus[k]}` : ""}</span>
                  <span className="muted">{statPct(total(k))}% per roll</span>
                  {c.unspent_points > 0 && <button className="small" disabled={busy} onClick={() => act(() => api.spend(k))}>+1</button>}
                </div>
              ))}
            </div>
          </section>

          <section className={`inv-pack ${over === "pack" ? "over" : ""}`} {...dropTarget("pack", (id) => { if (items.find((i) => i.id === id)?.equipped) void unequip(id); })}>
            <div className="pack-bar">
              {FILTERS.map((f) => (
                <button key={f.id} className={`small ${filter === f.id ? "selected" : ""}`} onClick={() => setFilter(f.id)}>
                  {f.label} <span className="muted">{items.filter((i) => !i.equipped && f.test(i)).length}</span>
                </button>
              ))}
              <span className="spacer" />
              <span className="muted">Sort</span>
              {(Object.keys(SORTS) as SortKey[]).map((s) => (
                <button key={s} className={`small ${sort === s ? "selected" : ""}`} onClick={() => setSort(s)}>{s}</button>
              ))}
            </div>
            <div className="pack-grid">
              {pack.map((item) => (
                <ItemTile
                  key={item.id}
                  item={item}
                  selected={selectedId === item.id}
                  locked={!!equipProblem(item, c.class_id, c.level)}
                  match={slotHint === item.slot}
                  onClick={() => (slotHint === item.slot && !equipProblem(item, c.class_id, c.level) ? (setSlotHint(null), void equip(item.id)) : setSelectedId(item.id))}
                  onDragStart={dragStart(item)}
                />
              ))}
              {pack.length === 0 && <p className="muted">{items.some((i) => !i.equipped) ? "Nothing of that kind in your pack." : "Your pack is empty. Islands and the market stall are where gear comes from."}</p>}
            </div>
          </section>

          <section className="inv-detail">
            {selected ? (
              <ItemDetail item={selected} current={worn.get(selected.slot) ?? null} equipped={selected.equipped} classId={c.class_id} level={c.level}>
                {selected.equipped ? (
                  selected.slot !== "main_hand" && <button disabled={busy} onClick={() => unequip(selected.id)}>Unequip</button>
                ) : (
                  <>
                    <button className="primary" disabled={busy || !!equipProblem(selected, c.class_id, c.level)} onClick={() => equip(selected.id)}>Equip</button>
                    <button disabled={busy} onClick={() => act(async () => { await api.sell(selected.id); setSelectedId(null); })}>Sell · {sellPrice(selected)}g</button>
                  </>
                )}
              </ItemDetail>
            ) : (
              <p className="muted">Select an item to see what it does and how it compares with what you are wearing.</p>
            )}
          </section>
        </div>

        <footer className="row">
          <button
            className="danger small"
            disabled={busy}
            onClick={() => {
              if (confirm("Re-roll? This discards the character and all its gear.")) void act(() => api.reroll());
            }}
          >
            Re-roll character
          </button>
          <button
            className="danger small"
            disabled={busy}
            onClick={() => {
              if (confirm("Leave this crew? You can rejoin with its invite code.")) void act(() => api.leaveCrew());
            }}
          >
            Leave crew
          </button>
        </footer>
      </div>
    </div>
  );
}
