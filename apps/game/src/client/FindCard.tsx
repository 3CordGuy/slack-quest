// The card that says what a searched cache gave up: gold, gear, materials, blueprints and decor, one chip
// each. It is read from the events of the step the search happened in.
//
// This is what is left of the old fight cards (the opening card and the recap went with the line-up
// fights); the gains chips are here for the new fights' spoils to reuse.

import type { ItemDef, Resources, WorldEvent } from "@gantt-quest/world";
import { RARITY_COLOR, RESOURCE_KINDS } from "@gantt-quest/world";
import { blueprintName } from "./hutDrops";
import { Icon } from "./items";
import { BlueprintIcon, GOLD_ICON, ThingIcon, brewIcon, furnishingIcon, resourceIcon } from "./thingIcons";
import { itemName, label } from "./labels";

/** A furnishing picked up on the voyage: its def id for the icon, and the name it was given. */
export interface Picked {
  defId: string;
  label: string;
}

/** Gold, materials, gear, blueprints and decor won, one chip each with its pixel icon. */
function GainChips({ gold, items, resources, blueprints, furnishings }: { gold: number; items: ItemDef[]; resources: Resources; blueprints: string[]; furnishings: Picked[] }) {
  return (
    <>
      {gold > 0 && <span className="chip gold with-icon"><ThingIcon icon={GOLD_ICON} size={18} />+{gold} gold</span>}
      {RESOURCE_KINDS.filter((k) => resources[k]).map((k) => (
        <span key={k} className="chip with-icon"><ThingIcon icon={resourceIcon(k)} size={18} />{resources[k]} {label("resource", k).toLowerCase()}</span>
      ))}
      {items.map((item, i) => (
        <span key={i} className="chip with-icon" style={{ borderColor: RARITY_COLOR[item.rarity], color: RARITY_COLOR[item.rarity] }}>
          <Icon name={item.icon} color={RARITY_COLOR[item.rarity]} size={18} />{itemName(item)}
        </span>
      ))}
      {blueprints.map((b, i) => <span key={`b${i}`} className="chip with-icon"><BlueprintIcon defId={b} size={18} />Blueprint: {blueprintName(b)}</span>)}
      {furnishings.map((f, i) => <span key={`f${i}`} className="chip with-icon"><ThingIcon icon={furnishingIcon(f.defId)} size={18} />{f.label}</span>)}
    </>
  );
}

// ---------- a cache opened ----------

export interface Find {
  hero: string;
  mine: boolean;
  xp: number;
  gold: number;
  items: ItemDef[];
  resources: Resources;
  /** Blueprint ids (furnishing def ids). */
  blueprints: string[];
  furnishings: Picked[];
  /** Two or more of the three rolls landed: there was a potion in it too. */
  potion: boolean;
}

/** What a successful search turned up, from the events of the step it happened in. Null if this step found nothing. */
export function findFor(events: WorldEvent[], you: string, names: Map<string, string>): Find | null {
  const at = events.findIndex((e) => e.t === "search" && e.found);
  const search = events[at];
  if (at < 0 || search.t !== "search") return null;
  const find: Find = { hero: names.get(search.heroId) ?? "Someone", mine: search.heroId === you, xp: 0, gold: 0, items: [], resources: {}, blueprints: [], furnishings: [], potion: false };
  const roll = events[at - 1];
  if (roll?.t === "check" && roll.check.successes >= 2) find.potion = true;
  for (const ev of events.slice(at + 1)) {
    if (!("heroId" in ev) || ev.heroId !== search.heroId) continue;
    if (ev.t === "xp") find.xp += ev.amount;
    else if (ev.t === "gold") find.gold += ev.amount;
    else if (ev.t === "loot") find.items.push(ev.item);
    else if (ev.t === "blueprint") find.blueprints.push(ev.blueprint);
    else if (ev.t === "furnishing") find.furnishings.push({ defId: ev.furnishing.defId, label: ev.furnishing.label });
    else if (ev.t === "resources") for (const [kind, n] of Object.entries(ev.resources)) find.resources[kind as keyof Resources] = (find.resources[kind as keyof Resources] ?? 0) + (n ?? 0);
  }
  return find;
}

export function FindCard({ find, onDone }: { find: Find; onDone(): void }) {
  const empty = find.gold === 0 && find.items.length === 0 && Object.keys(find.resources).length === 0 && find.blueprints.length === 0 && find.furnishings.length === 0;
  return (
    <div className="battle-card recap victory" role="dialog" aria-label="Treasure found">
      <h2>{find.mine ? "You found something!" : `${find.hero} found something!`}</h2>
      <p className="muted">The cache gives up what it was hiding.</p>
      <div className="recap-gains find-gains">
        {find.potion && <span className="chip with-icon"><ThingIcon icon={brewIcon("healing")} size={18} />A potion</span>}
        <GainChips gold={find.gold} items={find.items} resources={find.resources} blueprints={find.blueprints} furnishings={find.furnishings} />
        {find.xp > 0 && <span className="chip">+{find.xp} XP</span>}
        {empty && <span className="muted">Less than it promised.</span>}
      </div>
      <div className="row">
        <span className="spacer" />
        <button className="primary" autoFocus onClick={onDone}>Continue</button>
      </div>
    </div>
  );
}
