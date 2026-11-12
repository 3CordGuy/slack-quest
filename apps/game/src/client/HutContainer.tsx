// What a chest, crate or cupboard in your hut holds: decorations, gear and
// stacks of materials, all sharing its slots. Decorations move over the hut's
// socket like any furniture; gear and materials over HTTP, since they come
// out of (and go back into) the bag and the material pool.

import { useState } from "react";
import { CARRY_FORMULA, FURNISHINGS, RESOURCE_KINDS, carryProblem, type Furnishing, type HutClientMessage, type ResourceKind } from "@gantt-quest/world";
import { api, type Hut, type InventoryItem, type Me } from "./api";
import { label } from "./labels";

export function HutContainer({
  box,
  furnishings,
  own,
  bag,
  pack,
  send,
  act,
  carry,
}: {
  box: Furnishing;
  furnishings: Furnishing[];
  /** The owner's materials and what the containers hold; null while loading. */
  own: Hut | null;
  bag: InventoryItem[];
  /** How full the owner's pack is: gear only comes out of here while there is room in it. */
  pack: Me["carry"];
  send(message: HutClientMessage): void;
  /** Run a request, then re-read the hut and the bag. */
  act(fn: () => Promise<unknown>): void;
  /** Pick a decoration up to set it down in the room. */
  carry(id: number): void;
}) {
  const [addPiece, setAddPiece] = useState("");
  const [addGear, setAddGear] = useState("");
  const slots = FURNISHINGS[box.defId]?.storage ?? 0;
  const inside = furnishings.filter((f) => f.inId === box.id);
  const stash = own?.stash.filter((s) => s.containerId === box.id) ?? [];
  const stowed = own?.stowed.filter((g) => g.containerId === box.id) ?? [];
  const used = inside.length + stash.length + stowed.length;
  const full = used >= slots;
  const looseDecor = furnishings.filter((f) => f.q === null && f.inId === null && f.id !== box.id && !FURNISHINGS[f.defId]?.storage);
  const looseGear = bag.filter((i) => !i.equipped);
  const had = (k: ResourceKind) => stash.find((s) => s.kind === k)?.qty ?? 0;
  /** Why gear cannot come out into the pack right now, or null. */
  const packFull = pack ? carryProblem(pack, 1) : null;
  const kinds = RESOURCE_KINDS.filter((k) => (own?.resources[k] ?? 0) > 0 || had(k) > 0);

  return (
    <div className="hut-box">
      <p className="muted">Holds {used} of {slots}. Each piece of gear, each decoration and each kind of material takes a slot.</p>

      <h4>Decorations</h4>
      {inside.length === 0 && <p className="muted">None inside.</p>}
      <ul className="hut-list">
        {inside.map((f) => (
          <li key={f.id} className="hut-box-row">
            <span>{f.label}</span>
            <button className="small" onClick={() => carry(f.id)}>Set out</button>
            <button className="small" onClick={() => send({ type: "pick_up", id: f.id })}>To storage</button>
          </li>
        ))}
      </ul>
      {looseDecor.length > 0 && (
        <div className="row">
          <select value={addPiece} onChange={(e) => setAddPiece(e.target.value)} aria-label="Decoration to put in">
            <option value="">From storage…</option>
            {looseDecor.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
          <button className="small" disabled={!addPiece || full} onClick={() => (send({ type: "put_in", id: Number(addPiece), into: box.id }), setAddPiece(""))}>Put in</button>
        </div>
      )}

      <h4>Materials</h4>
      {!own ? <p className="muted">Counting…</p> : kinds.length === 0 ? <p className="muted">You have no materials to keep here.</p> : (
        <div className="hut-mats" role="table" aria-label="Materials">
          <div className="hut-mats-head" role="row">
            <span role="columnheader">Material</span>
            <span role="columnheader" title="In this container">Here</span>
            <span role="columnheader" title="On you">You</span>
            <span role="columnheader" />
          </div>
          {kinds.map((k) => {
            const have = own.resources[k] ?? 0;
            const kept = had(k);
            const room = kept > 0 || !full;
            const name = label("resource", k);
            return (
              <div key={k} role="row" className="hut-mats-row">
                <span role="cell">{name}</span>
                <strong role="cell">{kept}</strong>
                <span role="cell" className="muted">{have}</span>
                <span role="cell" className="hut-mats-btns">
                  <button className="small" disabled={!have || !room} title={`Put 1 ${name.toLowerCase()} in`} onClick={() => act(() => api.stash(box.id, k, 1))}>+1</button>
                  <button className="small" disabled={!have || !room} title={`Put all ${have} in`} onClick={() => act(() => api.stash(box.id, k, have))}>In</button>
                  <button className="small" disabled={!kept} title={`Take 1 ${name.toLowerCase()} out`} onClick={() => act(() => api.stash(box.id, k, -1))}>−1</button>
                  <button className="small" disabled={!kept} title={`Take all ${kept} out`} onClick={() => act(() => api.stash(box.id, k, -kept))}>Out</button>
                </span>
              </div>
            );
          })}
        </div>
      )}

      <h4>Gear</h4>
      {pack && (
        <p className={packFull ? "bad" : "muted"} title={`Pack size: ${CARRY_FORMULA}`}>
          Carried {pack.carried} / {pack.limit}.{packFull ? ` ${packFull}` : " Gear you cannot carry waits here; only you can take it out, and only here."}
        </p>
      )}
      {stowed.length === 0 && <p className="muted">None inside.</p>}
      <ul className="hut-list">
        {stowed.map((g) => (
          <li key={g.itemId} className="hut-box-row">
            <span className={`rarity-${g.rarity}`}>{g.name}</span>
            <button className="small" disabled={!!packFull} title={packFull ?? "Into your pack"} onClick={() => act(() => api.stow(null, g.itemId))}>To bag</button>
          </li>
        ))}
      </ul>
      {looseGear.length > 0 && (
        <div className="row">
          <select value={addGear} onChange={(e) => setAddGear(e.target.value)} aria-label="Gear to put in">
            <option value="">From your bag…</option>
            {looseGear.map((i) => <option key={i.id} value={i.id}>{i.name}</option>)}
          </select>
          <button className="small" disabled={!addGear || full} onClick={() => (act(() => api.stow(box.id, Number(addGear))), setAddGear(""))}>Put in</button>
        </div>
      )}
    </div>
  );
}
