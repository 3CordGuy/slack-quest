// Hut materials and costs as the panels show them: a line of wording and
// rows of icon-and-count chips.

import { RESOURCE_KINDS, type Resources } from "@gantt-quest/world";
import { GOLD_ICON, ThingIcon, resourceIcon } from "./thingIcons";
import "./hutDrops.css";
import { label } from "./labels";

/** "2 fur, 1 bone", in the catalogue's order. */
export function resourceText(resources: Resources): string {
  return RESOURCE_KINDS.filter((k) => resources[k]).map((k) => `${resources[k]} ${label("resource", k).toLowerCase()}`).join(", ");
}

/** One chip per resource. With `all`, kinds the player has none of are shown as zero. */
export function ResourceChips({ resources, all = false }: { resources: Resources; all?: boolean }) {
  return (
    <div className="res-chips">
      {RESOURCE_KINDS.filter((k) => all || resources[k]).map((k) => (
        <span key={k} className={`res-chip ${resources[k] ? "" : "none"}`} title={label("resource", k)}>
          <ThingIcon icon={resourceIcon(k)} size={22} />
          <strong>{resources[k] ?? 0}</strong>
          <span className="res-name">{label("resource", k)}</span>
        </span>
      ))}
    </div>
  );
}

/** Gold and materials as small icon-and-count chips (the name is the tooltip): an errand's pay, what a workshop visitor holds. With `zeros`, kinds given as 0 still show. */
export function RewardChips({ gold, resources = {}, zeros = false }: { gold?: number; resources?: Resources; zeros?: boolean }) {
  return (
    <span className="cost-chips reward-chips">
      {gold || (zeros && gold !== undefined) ? <span className="cost" title="Gold"><ThingIcon icon={GOLD_ICON} size={18} /> {gold}g</span> : null}
      {RESOURCE_KINDS.filter((k) => resources[k] || (zeros && resources[k] !== undefined)).map((k) => (
        <span key={k} className="cost" title={label("resource", k)}>
          <ThingIcon icon={resourceIcon(k)} size={18} /> {resources[k]}
        </span>
      ))}
    </span>
  );
}

/** A recipe or price in materials, each amount marked short when `have` does not cover it. */
export function CostChips({ cost, have, gold, haveGold }: { cost: Resources; have: Resources; gold?: number; haveGold?: number }) {
  return (
    <span className="cost-chips">
      {gold ? <span className={`cost ${(haveGold ?? 0) < gold ? "short" : ""}`} title={`You have ${haveGold ?? 0} gold`}><ThingIcon icon={GOLD_ICON} size={18} /> {gold}g</span> : null}
      {RESOURCE_KINDS.filter((k) => cost[k]).map((k) => (
        <span key={k} className={`cost ${(have[k] ?? 0) < cost[k]! ? "short" : ""}`} title={`${label("resource", k)}: you have ${have[k] ?? 0}`}>
          <ThingIcon icon={resourceIcon(k)} size={18} /> {have[k] ?? 0}/{cost[k]}
        </span>
      ))}
    </span>
  );
}
