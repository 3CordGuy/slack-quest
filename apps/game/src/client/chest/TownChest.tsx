// The town chest: one store the whole crew shares, standing in the square
// (packages/world/src/townchest.ts decides what its tabs hold; server/townchest.ts
// moves things in and out). It opens like a chest at home: its window beside
// the sea bag (InventoryScreen.tsx draws both), with things dragged across.
//
// This reads the chest, keeps it fresh while it is open (a crewmate may have
// reached in), and draws the tabs across its top:
//
//   click a tab          look in it
//   drag a tab           move it among the others
//   double-click a tab   name it again, there in the tab, and pick its colour
//                        (so does a right-click, and the Edit button)
//   +                    buy the crew another tab, with your own gold
//
// Anyone in the crew may take out what anyone put in, and the tabs' names,
// colours and order are everyone's.

import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type KeyboardEvent } from "react";
import { TOWN_TAB_COLORS, TOWN_TAB_NAME, movedTabs, type TabColor, type TabKind } from "@gantt-quest/world";
import { api, type ChestView, type Me } from "../api";
import { InventoryScreen } from "../InventoryScreen";
import { Icon } from "../items";
import { ThingIcon, resourceIcon } from "../thingIcons";
import { STONE_ICON } from "../zone/actionIcons";
import "./townchest.css";

type Tab = ChestView["tabs"][number];
/** How often the chest is looked at again while it is open. */
const REFRESH_MS = 6000;
/** Where the tab last looked in is remembered, for as long as the browser tab is open. */
const AT = "gq.chest.tab";
const TAB_HINT: Record<TabKind, string> = {
  general: "Gear, materials and lodestones, on squares like a chest at home",
  materials: "A place for every material, and no squares to run out of",
  lodestones: "Lodestones, shelved by how much they carry",
};
/** What each colour a tab can be given looks like, and what to call it. */
const TAB_HEX: Record<TabColor, string> = { brass: "#c9a25a", red: "#c8473c", orange: "#d98236", gold: "#e6c545", green: "#6fa84a", teal: "#3fa39a", blue: "#4f8fc4", violet: "#8a6cc9", rose: "#d0709a", slate: "#7d8794" };
/** The colour a tab wears until the crew gives it one: the tabs that keep one sort of thing have their own. */
const KIND_COLOR: Record<TabKind, TabColor | null> = { general: null, materials: "green", lodestones: "blue" };
const tint = (t: Pick<Tab, "color" | "kind">): CSSProperties | undefined => {
  const c = t.color ?? KIND_COLOR[t.kind];
  return c ? ({ "--tab": TAB_HEX[c] } as CSSProperties) : undefined;
};

/**
 * The chest as it was last read, kept between openings: it opens on this at once, with nothing to wait for,
 * and is read again behind it. The Harbor reads it ahead of time (`readChestAhead`), so even the first
 * opening has it.
 */
let lastRead: ChestView | null = null;
export const readChestAhead = () => void api.chest().then((v) => (lastRead = v), () => undefined);

/** The small picture on a tab that keeps one sort of thing. */
function TabGlyph({ kind }: { kind: TabKind }) {
  if (kind === "materials") return <ThingIcon icon={resourceIcon("wood")} size={16} />;
  if (kind === "lodestones") return <Icon name={STONE_ICON(1).name} color={STONE_ICON(1).color} size={16} flat />;
  return null;
}

export function TownChest({ me, refresh, onClose }: { me: Me; refresh(): Promise<unknown>; onClose(): void }) {
  const [view, setView] = useState<ChestView | null>(lastRead);
  useEffect(() => {
    if (view) lastRead = view;
  }, [view]);
  const [tabId, setTabId] = useState<number | null>(() => {
    try {
      return Number(sessionStorage.getItem(AT)) || null;
    } catch {
      return null;
    }
  });
  const [error, setError] = useState<string | null>(null);
  /** The tab being named again, there in the bar, and the name as typed so far. Its colours are offered meanwhile. */
  const [editing, setEditing] = useState<{ id: number; name: string } | null>(null);
  /** The name typed for a tab about to be bought; null when none is being bought. */
  const [buying, setBuying] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** A tab being dragged along the bar, and where among the others it would stand if let go. */
  const [drag, setDrag] = useState<{ id: number; to: number } | null>(null);
  const press = useRef<{ id: number; x: number; y: number; dragging: boolean } | null>(null);
  /** Counts every change asked of the chest, so an answer to an older look at it is not shown over a newer one. */
  const stamp = useRef(0);

  const load = useCallback(() => {
    const at = stamp.current;
    return api.chest().then((v) => stamp.current === at && setView(v), (e: Error) => setError(e.message));
  }, []);
  useEffect(() => {
    void load();
    const every = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(every);
  }, [load]);

  /** Ask something of the chest and show it as it comes back. A refusal is passed on, and the chest read again. */
  const ask = (run: () => Promise<ChestView>) => {
    stamp.current++;
    return run().then(
      (v) => {
        stamp.current++;
        setView(v);
        setError(null);
      },
      (e: Error) => {
        stamp.current++;
        void load();
        throw e;
      },
    );
  };
  /** The same for what is done to the tabs themselves: shown at once, and a refusal said in the bar. */
  const change = (show: (tabs: Tab[]) => Tab[], run: () => Promise<ChestView>) => {
    setView((was) => (was ? { ...was, tabs: show(was.tabs) } : was));
    ask(run).catch((e: Error) => setError(e.message));
  };

  const tab = view?.tabs.find((t) => t.id === tabId) ?? view?.tabs[0] ?? null;
  const pick = (id: number) => {
    setTabId(id);
    setError(null);
    try {
      sessionStorage.setItem(AT, String(id));
    } catch {
      // Not remembered: the chest opens on its first tab next time.
    }
  };

  // ---- naming a tab again, in the tab; its colour beside it ----
  /** What is being named right now, whatever render a handler was made in: the box losing the typing as it goes must not keep a name twice, or one that was left. */
  const naming = useRef(editing);
  naming.current = editing;
  const edit = (t: Tab) => {
    pick(t.id);
    setBuying(null);
    setEditing({ id: t.id, name: t.name });
  };
  const leaveName = () => {
    naming.current = null;
    setEditing(null);
  };
  /** Keep the name as typed (if it is one, and another), and stop naming. */
  const keepName = () => {
    const e = naming.current;
    leaveName();
    const name = e?.name.replace(/\s+/g, " ").trim();
    if (!e || !name || name === view?.tabs.find((t) => t.id === e.id)?.name) return;
    change((tabs) => tabs.map((t) => (t.id === e.id ? { ...t, name } : t)), () => api.chestRenameTab(e.id, name));
  };
  const colour = (id: number, color: TabColor | null) => change((tabs) => tabs.map((t) => (t.id === id ? { ...t, color } : t)), () => api.chestColorTab(id, color));
  /** Typing a name is not steering the game: the keys stay in the box. Enter keeps the name, Escape leaves it as it was. */
  const typing = (e: KeyboardEvent, keep: () => void, drop: () => void) => {
    e.stopPropagation();
    if (e.key === "Enter") {
      e.preventDefault();
      keep();
    } else if (e.key === "Escape") drop();
  };

  // ---- dragging a tab along the bar ----
  const dragging = useRef(drag);
  dragging.current = drag;
  useEffect(() => {
    const move = (e: PointerEvent) => {
      const p = press.current;
      if (!p || (!p.dragging && Math.hypot(e.clientX - p.x, e.clientY - p.y) < 6)) return;
      p.dragging = true;
      // Where it would stand among the others: before the first of them the pointer is left of (or above, where the bar has wrapped).
      const others = [...document.querySelectorAll<HTMLElement>(".town-tabs [data-tab]")].filter((el) => Number(el.dataset.tab) !== p.id);
      const before = others.findIndex((el) => {
        const r = el.getBoundingClientRect();
        return e.clientY < r.top || (e.clientY <= r.bottom && e.clientX < r.left + r.width / 2);
      });
      const to = before < 0 ? others.length : before;
      setDrag((was) => (was?.id === p.id && was.to === to ? was : { id: p.id, to }));
    };
    const up = () => {
      const p = press.current;
      const d = dragging.current;
      press.current = null;
      setDrag(null);
      if (!p?.dragging) return;
      // The release would otherwise count as a click on the tab under it.
      const swallow = (ev: MouseEvent) => {
        ev.stopPropagation();
        ev.preventDefault();
      };
      addEventListener("click", swallow, { capture: true, once: true });
      setTimeout(() => removeEventListener("click", swallow, { capture: true }), 0);
      if (d) change((tabs) => (movedTabs(tabs.map((t) => t.id), d.id, d.to) ?? []).map((id) => tabs.find((t) => t.id === id)!), () => api.chestMoveTab(d.id, d.to));
    };
    addEventListener("pointermove", move);
    addEventListener("pointerup", up);
    addEventListener("pointercancel", up);
    return () => {
      removeEventListener("pointermove", move);
      removeEventListener("pointerup", up);
      removeEventListener("pointercancel", up);
    };
    // `change` reads nothing that goes stale: it sets state from what was, and asks the server.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  /** The tabs as they are shown: in their order, with one being dragged standing where it would be let go. */
  const order = view && drag ? movedTabs(view.tabs.map((t) => t.id), drag.id, drag.to) : null;
  const shown = view ? (order ? order.map((id) => view.tabs.find((t) => t.id === id)!) : view.tabs) : [];

  // ---- buying another ----
  const gold = me.character?.gold ?? 0;
  const cost = view?.nextTab ?? null;
  const general = view?.tabs.filter((t) => t.kind === "general").length ?? 0;
  const buy = async (e: FormEvent) => {
    e.preventDefault();
    if (buying === null || busy || !view) return;
    const name = buying.trim();
    const had = new Set(view.tabs.map((t) => t.id));
    setBusy(true);
    try {
      await ask(async () => {
        const next = await api.chestBuyTab(name || undefined);
        // Look in the new one straight away.
        const made = next.tabs.find((t) => !had.has(t.id));
        if (made) pick(made.id);
        return next;
      });
      setBuying(null);
      // The gold came out of the pack.
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const edited = editing ? view?.tabs.find((t) => t.id === editing.id) ?? null : null;
  const bar = (
    <div className="town-bar">
      <div className={`town-tabs ${drag ? "moving" : ""}`} role="tablist" aria-label="Tabs of the town chest">
        {shown.map((t) =>
          editing?.id === t.id ? (
            <span key={t.id} data-tab={t.id} className={`town-tab on editing ${t.kind}`} style={tint(t)}>
              <TabGlyph kind={t.kind} />
              <input
                autoFocus
                value={editing.name}
                maxLength={TOWN_TAB_NAME}
                aria-label="The tab's name"
                style={{ width: `${Math.max(5, editing.name.length + 2)}ch` }}
                onFocus={(e) => e.target.select()}
                onChange={(e) => setEditing({ id: t.id, name: e.target.value })}
                onKeyDown={(e) => typing(e, keepName, leaveName)}
                onKeyUp={(e) => e.stopPropagation()}
                onBlur={keepName}
              />
            </span>
          ) : (
            <button
              key={t.id}
              data-tab={t.id}
              role="tab"
              aria-selected={t.id === tab?.id}
              className={`town-tab ${t.kind} ${t.id === tab?.id ? "on" : ""} ${drag?.id === t.id ? "dragged" : ""}`}
              style={tint(t)}
              title={`${TAB_HINT[t.kind]}\nDrag to move it · double-click to name and colour it`}
              onPointerDown={(e) => {
                if (e.button === 0) press.current = { id: t.id, x: e.clientX, y: e.clientY, dragging: false };
              }}
              onClick={() => pick(t.id)}
              onDoubleClick={() => edit(t)}
              onContextMenu={(e) => {
                e.preventDefault();
                e.stopPropagation();
                edit(t);
              }}
            >
              <TabGlyph kind={t.kind} />
              {t.name}
            </button>
          ),
        )}
        {view && cost !== null && (
          <button className={`town-tab add ${buying !== null ? "on" : ""}`} aria-label="Buy another tab" title={`Another tab for the whole crew: ${cost} gold`} onClick={() => (keepName(), setBuying((was) => (was === null ? "" : null)))}>+</button>
        )}
        <span className="spacer" />
        {tab && !editing && <button className="small town-edit" title="Name this tab again, and pick its colour" onClick={() => edit(tab)}>Edit</button>}
      </div>
      {edited && (
        // Pressing a colour must not take the typing out of the name: the name is kept when it loses it.
        <div className="town-colors" role="group" aria-label="The tab's colour" onMouseDown={(e) => e.preventDefault()}>
          <span className="muted">Colour</span>
          <button className={`town-swatch none ${edited.color === null ? "on" : ""}`} title="No colour of its own" aria-label="No colour" aria-pressed={edited.color === null} onClick={() => colour(edited.id, null)} />
          {TOWN_TAB_COLORS.map((c) => (
            <button key={c} className={`town-swatch ${edited.color === c ? "on" : ""}`} style={{ "--tab": TAB_HEX[c] } as CSSProperties} title={c[0].toUpperCase() + c.slice(1)} aria-label={c} aria-pressed={edited.color === c} onClick={() => colour(edited.id, c)} />
          ))}
          <span className="spacer" />
          <span className="muted town-keys">Enter keeps the name · Esc leaves it</span>
        </div>
      )}
      {buying !== null && (
        <form className="town-naming" onSubmit={(e) => void buy(e)}>
          <span className="muted">A new tab, for the whole crew:</span>
          <input
            autoFocus
            value={buying}
            maxLength={TOWN_TAB_NAME}
            placeholder={`Chest ${general + 1}`}
            aria-label="The new tab's name"
            onChange={(e) => setBuying(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setBuying(null);
            }}
            onKeyUp={(e) => e.stopPropagation()}
          />
          <button className="small primary" disabled={busy || cost === null || gold < cost} title={cost !== null && gold < cost ? `You carry ${gold} gold` : "Out of your own gold, for everyone"}>Buy · {cost} gold</button>
          <button type="button" className="small" onClick={() => setBuying(null)}>Cancel</button>
        </form>
      )}
      {error && <p className="bad town-note" role="alert">{error}</p>}
    </div>
  );

  return (
    <InventoryScreen
      me={me}
      refresh={refresh}
      onClose={onClose}
      town={{
        tab,
        bar,
        stow: (item) => ask(() => api.chestStow(tab!.id, item)),
        unstow: (item) => ask(() => api.chestUnstow(item)),
        put: (kind, qty) => ask(() => api.chestPut(tab!.id, kind, qty)),
        take: (kind, qty) => ask(() => api.chestTake(tab!.id, kind, qty)),
        onClose,
      }}
    />
  );
}
