// The town chest: one store the whole crew shares, standing in the plaza
// (packages/world/src/townchest.ts decides what it holds and how big it is;
// server/townchest.ts moves things in and out). A window with a tab for each
// sort of thing it keeps: on the left what is in the chest, on the right what
// of that sort is in your own pack.
//
//   click          move the whole stack across
//   right click    move part of it: asks how many
//
// Anyone in the crew may take out what anyone put in. A tab is made a row
// bigger with gold and materials from the pack of whoever pays, for everyone.

import { useCallback, useEffect, useState } from "react";
import { CHEST_TABS, RESOURCE_KINDS, TOWN_CHEST_COLS, chestRowCost, chestUsed, stoneItem, stoneOfItem, type ChestTab, type ResourceKind } from "@gantt-quest/world";
import { api, type ChestView, type Me } from "../api";
import { DragPanel } from "../DragPanel";
import { label } from "../labels";
import { SlotGrid, SplitPrompt, StackTile, matStacks, stackName, stoneStacks, type Stack } from "../ui/Slots";
import "./townchest.css";

/** How often the chest is looked at again while its window is open: a crewmate may have reached in. */
const REFRESH_MS = 6000;
type Held = Extract<Stack, { t: "mat" | "stone" }>;
/** What a stack is called in the chest's own books. */
const kindOf = (s: Held) => (s.t === "mat" ? s.kind : stoneItem(s.stone));

export function TownChest({ me, refresh, onClose }: { me: Me; refresh(): Promise<unknown>; onClose(): void }) {
  const [view, setView] = useState<ChestView | null>(null);
  const [tab, setTab] = useState<ChestTab>("lodestones");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [split, setSplit] = useState<{ stack: Held; into: boolean; at: { x: number; y: number } } | null>(null);

  const load = useCallback(() => api.chest().then(setView, (e: Error) => setError(e.message)), []);
  useEffect(() => {
    void load();
    const every = setInterval(() => void load(), REFRESH_MS);
    return () => clearInterval(every);
  }, [load]);

  const here = view?.tabs.find((t) => t.id === tab);
  // What is in this tab of the chest, and what of the same sort is in the pack, as stacks.
  const inChest = (here?.held ?? []).flatMap((h): Stack[] => {
    if (tab === "materials") return matStacks(h.kind as ResourceKind, h.qty);
    const stone = stoneOfItem(h.kind);
    return stone ? stoneStacks(stone, h.qty) : [];
  }) as Held[];
  const inPack = (tab === "materials" ? RESOURCE_KINDS.flatMap((k) => matStacks(k, me.materials?.[k] ?? 0)) : (me.lodestones ?? []).flatMap((h) => stoneStacks(h.stone, h.qty))) as Held[];
  const used = here ? chestUsed(Object.fromEntries(here.held.map((h) => [h.kind, h.qty]))) : 0;
  const squares = (here?.rows ?? 0) * TOWN_CHEST_COLS;
  const cost = here ? chestRowCost(here.rows) : null;
  const canPay = !!cost && (me.character?.gold ?? 0) >= cost.gold && Object.entries(cost.resources).every(([kind, n]) => (me.materials?.[kind as ResourceKind] ?? 0) >= n!);

  /** Do something to the chest, then look at the pack again: what went in or came out is the hero's own. */
  const act = async (run: () => Promise<ChestView>) => {
    setBusy(true);
    setError(null);
    try {
      setView(await run());
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      void load();
    } finally {
      setBusy(false);
    }
  };
  const move = (stack: Held, into: boolean, n = stack.qty) => void act(() => (into ? api.chestPut(tab, kindOf(stack), n) : api.chestTake(tab, kindOf(stack), n)));

  const tiles = (stacks: Held[], into: boolean) =>
    stacks.map((s) => (
      <StackTile
        key={s.key}
        stack={s}
        size={44}
        onClick={() => !busy && move(s, into)}
        onSplit={s.qty > 1 ? (at) => setSplit({ stack: s, into, at }) : undefined}
      />
    ));

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="harbor.chest" title="The town chest" compact className="panel town-chest" role="dialog" aria-label="The town chest">
        <header className="town-chest-head">
          <h2>The town chest</h2>
          <span className="spacer" />
          <button className="small" onClick={onClose}>Close</button>
        </header>
        <p className="muted town-chest-intro">The crew's own store. Whatever one of you puts in, any of you may take out.</p>
        <div className="town-chest-tabs" role="tablist" aria-label="Tabs of the chest">
          {CHEST_TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={t.id === tab} className={t.id === tab ? "on" : ""} onClick={() => (setTab(t.id), setError(null))}>{t.name}</button>
          ))}
        </div>
        <p className="muted small-note">{CHEST_TABS.find((t) => t.id === tab)!.blurb} Click a stack to move it across; right-click to move part of it.</p>
        {error && <p className="bad" role="alert">{error}</p>}
        {!view && !error && <p className="muted">Lifting the lid…</p>}
        {here && (
          <div className="town-chest-sides">
            <section>
              <h3>In the chest <span className="muted">· {used} of {squares} squares</span></h3>
              <SlotGrid total={squares} label="In the chest">{tiles(inChest, false)}</SlotGrid>
              <p className="town-chest-grow">
                {cost ? (
                  <button className="small" disabled={busy || !canPay} onClick={() => void act(() => api.chestRow(tab))} title={canPay ? "For the whole crew" : "You have not the gold and materials for it in your pack"}>
                    Add a row <span className="muted">· {cost.gold} gold, {Object.entries(cost.resources).map(([kind, n]) => `${n} ${label("resource", kind).toLowerCase()}`).join(", ")}</span>
                  </button>
                ) : (
                  <span className="muted">This tab is as big as it can be made.</span>
                )}
              </p>
            </section>
            <section>
              <h3>In your pack</h3>
              {inPack.length === 0 ? (
                <p className="muted">{tab === "lodestones" ? "You carry no lodestones." : "You carry no materials."}</p>
              ) : (
                <SlotGrid total={Math.max(TOWN_CHEST_COLS, inPack.length)} label="In your pack">{tiles(inPack, true)}</SlotGrid>
              )}
            </section>
          </div>
        )}
      </DragPanel>
      {split && (
        <SplitPrompt
          name={stackName(split.stack)}
          max={split.stack.qty}
          at={split.at}
          verb={split.into ? "Put in" : "Take"}
          onPick={(n) => {
            move(split.stack, split.into, n);
            setSplit(null);
          }}
          onClose={() => setSplit(null)}
        />
      )}
    </div>
  );
}
