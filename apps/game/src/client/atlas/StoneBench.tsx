// The lodestone bench: where a hero works the stones in their pack into the
// ones they want (packages/world/src/stonecraft.ts has the rules;
// server/lodestones.ts does the work and rolls what comes of it). It stands
// in the Harbor, beside the smithy at the west end of the High Street: stones are made ready
// here before a crew goes up to the atlas with them. A plain one, which
// carries nothing and only opens a place, is cut here from stone and iron.
//
//   Fuse     three stones that carry the same number of things, into one
//            that carries one more.
//   Attune   one chosen thing added to a stone, for gold and its material.
//   Temper   one thing a stone carries raised a rank: dear, and takes gems.
//   Reroll   what a stone carries changed for as many other things, for gold.
//
// A peril (teal for the ground, red for the enemy) makes a place harder and
// its bounty bigger; a boon (gold) is more of one thing in the bounty.
//
// The stones in the pack are along the top; click one to lay it on the
// bench (three for fusing, one for the rest). What a stone carries is told
// by pointing at it, as everywhere.

import { useEffect, useState } from "react";
import { FUSE_COUNT, PLAIN_STONE_COST, STONE_MODS, ZONE_MOD_IDS, attuneCost, attuneProblem, fuseProblem, modEffect, modName, modOf, modSide, modToken, rerollCost, rerollProblem, stoneKey, stoneName, temperCost, temperProblem, type Lodestone, type ResourceKind, type ZoneModId } from "@gantt-quest/world";
import { api, type Me } from "../api";
import { DragPanel } from "../DragPanel";
import { Icon } from "../items";
import { label } from "../labels";
import { STONE_ICON } from "../zone/actionIcons";
import "./bench.css";

type Work = "fuse" | "attune" | "temper" | "reroll";
const WORKS: { id: Work; name: string; blurb: string }[] = [
  { id: "fuse", name: "Fuse", blurb: `Lay ${FUSE_COUNT} lodestones that carry the same number of things on the bench. They become one that carries one more, drawn from what they carried.` },
  { id: "attune", name: "Attune", blurb: "Lay one lodestone on the bench and choose one more thing for it to carry. It costs gold and what that thing is made of: more the more the stone carries, and the rarer the thing." },
  { id: "temper", name: "Temper", blurb: "Lay one lodestone on the bench and raise one thing it carries by a rank: a peril more perilous and better paid, a boon richer. It is dear, and takes gems." },
  { id: "reroll", name: "Reroll", blurb: "Lay one lodestone on the bench. For gold it will carry as many other things: never just what it had." },
];
const carries = (stone: Lodestone) => (stone.length === 0 ? "Carries nothing: it only opens a place." : stone.map((id) => `${modName(id)}: ${modEffect(id).blurb}`).join("\n"));

function StoneTile({ stone, qty, dim, onClick, label: says }: { stone: Lodestone; qty?: number; dim?: boolean; onClick?(): void; label: string }) {
  const icon = STONE_ICON(stone.length);
  return (
    <button type="button" className={`bench-stone ${dim ? "dim" : ""}`} onClick={onClick} disabled={!onClick} aria-label={says} title={`${stoneName(stone)}\n${carries(stone)}`}>
      <Icon name={icon.name} color={icon.color} size={34} />
      {qty !== undefined && <span className="bench-qty">{qty}</span>}
      {stone.length > 0 && <span className="bench-pips">{stone.map((id) => <i key={id} className={modEffect(id).kind} />)}</span>}
    </button>
  );
}

export function StoneBench({ me, refresh, onClose }: { me: Me; refresh(): Promise<unknown>; onClose(): void }) {
  const [work, setWork] = useState<Work>("fuse");
  /** The stones laid on the bench, out of the pack: not used up until the work is done. */
  const [laid, setLaid] = useState<Lodestone[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<Lodestone | null>(null);
  const held = me.lodestones ?? [];
  const room = work === "fuse" ? FUSE_COUNT : 1;
  useEffect(() => setLaid([]), [work]);

  /** How many of a kind of stone are in the pack and not on the bench. */
  const left = (stone: Lodestone) => (held.find((h) => stoneKey(h.stone) === stoneKey(stone))?.qty ?? 0) - laid.filter((s) => stoneKey(s) === stoneKey(stone)).length;
  // Whatever is on the bench is still in the pack: something else may have used it meanwhile.
  const bench = laid.filter((s, i) => (held.find((h) => stoneKey(h.stone) === stoneKey(s))?.qty ?? 0) > laid.slice(0, i).filter((o) => stoneKey(o) === stoneKey(s)).length);
  const lay = (stone: Lodestone) => {
    setMade(null);
    setError(null);
    setLaid((was) => (was.length >= room ? [...was.slice(1), stone] : [...was, stone]));
  };
  const one = bench[0] ?? null;
  const gold = me.character?.gold ?? 0;
  const has = (kind: string, n: number) => (me.materials?.[kind as ResourceKind] ?? 0) >= n;

  const run = async (go: () => Promise<{ made: Lodestone }>) => {
    setBusy(true);
    setError(null);
    try {
      const done = await go();
      setMade(done.made);
      setLaid([]);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const cutCost = Object.entries(PLAIN_STONE_COST) as [string, number][];
  const canCut = cutCost.every(([kind, n]) => has(kind, n));
  const cut = async () => {
    setBusy(true);
    setError(null);
    try {
      await api.cutStone();
      setMade(null);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const fuseWhy = work === "fuse" ? (bench.length < FUSE_COUNT ? `Lay ${FUSE_COUNT - bench.length} more on the bench.` : fuseProblem(bench)) : null;

  return (
    <div className="overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <DragPanel id="atlas.bench" title="The lodestone bench" compact className="panel stone-bench" role="dialog" aria-label="The lodestone bench">
        <header className="bench-head">
          <h2>The lodestone bench</h2>
          <span className="spacer" />
          <button className="small" onClick={onClose}>Close</button>
        </header>
        <div className="bench-tabs" role="tablist" aria-label="Work at the bench">
          {WORKS.map((w) => (
            <button key={w.id} role="tab" aria-selected={w.id === work} className={w.id === work ? "on" : ""} onClick={() => (setWork(w.id), setMade(null), setError(null))}>{w.name}</button>
          ))}
        </div>
        <p className="muted small-note">{WORKS.find((w) => w.id === work)!.blurb}</p>

        <h3>In your pack</h3>
        <p className="bench-do">
          <button className="small" disabled={busy || !canCut} onClick={() => void cut()} title={canCut ? "Into your pack" : "You have not the materials in your pack"}>
            Cut a plain lodestone <span className="muted">· {cutCost.map(([kind, n]) => `${n} ${label("resource", kind).toLowerCase()}`).join(", ")}</span>
          </button>
          <span className="muted small-note">It carries nothing: it only opens a place.</span>
        </p>
        {held.length === 0 ? (
          <p className="muted">You carry no lodestones.</p>
        ) : (
          <div className="bench-row">
            {held.map(({ stone, qty }) => (
              <StoneTile key={stoneKey(stone)} stone={stone} qty={left(stone)} dim={left(stone) <= 0} onClick={left(stone) > 0 ? () => lay(stone) : undefined} label={`${stoneName(stone)}, ${qty} in your pack: lay it on the bench`} />
            ))}
          </div>
        )}

        <h3>On the bench</h3>
        <div className="bench-row bench-slots">
          {Array.from({ length: room }, (_, i) =>
            bench[i] ? (
              <StoneTile key={i} stone={bench[i]} onClick={() => setLaid((was) => was.filter((_, at) => at !== i))} label={`${stoneName(bench[i])}: take it off the bench`} />
            ) : (
              <span key={i} className="bench-stone empty" aria-hidden />
            ),
          )}
          {made && (
            <span className="bench-made">
              <span className="bench-arrow" aria-hidden>→</span>
              <StoneTile stone={made} label={stoneName(made)} />
              <span><strong>{stoneName(made)}</strong><br /><span className="muted small-note">{made.map((id) => modName(id)).join(", ")}</span></span>
            </span>
          )}
        </div>

        {error && <p className="bad" role="alert">{error}</p>}

        {work === "fuse" && (
          <p className="bench-do">
            <button className="primary" disabled={busy || !!fuseWhy} onClick={() => void run(() => api.benchFuse(bench.map(stoneKey)))}>Fuse them</button>
            {fuseWhy && <span className="muted">{fuseWhy}</span>}
          </p>
        )}

        {work === "attune" && (
          one ? (
            one.length >= STONE_MODS ? (
              <p className="muted">It carries all a lodestone can.</p>
            ) : (
              <ul className="bench-mods">
                {ZONE_MOD_IDS.filter((id) => !attuneProblem(one, id)).map((id: ZoneModId) => {
                  const cost = attuneCost(one, id);
                  const needs = Object.entries(cost.resources) as [string, number][];
                  const can = gold >= cost.gold && needs.every(([kind, n]) => has(kind, n));
                  return (
                    <li key={id} className={modEffect(id).kind}>
                      <span>
                        <strong>{modName(id)}</strong> <span className="muted">· {modSide(id)}</span>
                        <br />
                        <span className="small-note">{modEffect(id).blurb}</span>
                      </span>
                      <button className="small" disabled={busy || !can} title={can ? "It is spent from your pack" : "You have not the gold and materials for it in your pack"} onClick={() => void run(() => api.benchAttune(stoneKey(one), id))}>
                        {cost.gold} gold, {needs.map(([kind, n]) => `${n} ${label("resource", kind).toLowerCase()}`).join(", ")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            )
          ) : (
            <p className="muted">Lay a lodestone on the bench.</p>
          )
        )}

        {work === "temper" && (
          one ? (
            one.some((id) => !temperProblem(one, id)) ? (
              <ul className="bench-mods">
                {one.filter((id) => !temperProblem(one, id)).map((id) => {
                  const cost = temperCost(id);
                  const needs = Object.entries(cost.resources) as [string, number][];
                  const can = gold >= cost.gold && needs.every(([kind, n]) => has(kind, n));
                  const next = modToken(modOf(id)!.id, modOf(id)!.rank + 1);
                  return (
                    <li key={id} className={modEffect(id).kind}>
                      <span>
                        <strong>{modName(id)} → {modName(next)}</strong> <span className="muted">· {modSide(id)}</span>
                        <br />
                        <span className="small-note">{modEffect(next).blurb}</span>
                      </span>
                      <button className="small" disabled={busy || !can} title={can ? "It is spent from your pack" : "You have not the gold and materials for it in your pack"} onClick={() => void run(() => api.benchTemper(stoneKey(one), id))}>
                        {cost.gold} gold, {needs.map(([kind, n]) => `${n} ${label("resource", kind).toLowerCase()}`).join(", ")}
                      </button>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <p className="muted">{one.length === 0 ? "A plain lodestone carries nothing to temper." : "Nothing it carries can be raised any further."}</p>
            )
          ) : (
            <p className="muted">Lay a lodestone on the bench.</p>
          )
        )}

        {work === "reroll" && (
          <p className="bench-do">
            <button className="primary" disabled={busy || !one || !!rerollProblem(one) || gold < rerollCost(one)} onClick={() => one && void run(() => api.benchReroll(stoneKey(one)))}>
              Reroll it{one && !rerollProblem(one) ? ` · ${rerollCost(one)} gold` : ""}
            </button>
            <span className="muted">{!one ? "Lay a lodestone on the bench." : rerollProblem(one) ?? (gold < rerollCost(one) ? "You have not the gold." : "")}</span>
          </p>
        )}
      </DragPanel>
    </div>
  );
}
