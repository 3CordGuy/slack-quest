// Hut materials as the voyage and the inventory show them: feed wording, a
// row of resource counts, and the list on the ending screen.

import { FURNISHINGS, PERK_CAPS, RESOURCE_KINDS, type Earned, type FurnishingGrant, type Perk, type Resources } from "@gantt-quest/world";
import { BlueprintIcon, GOLD_ICON, ThingIcon, furnishingIcon, resourceIcon } from "./thingIcons";
import "./hutDrops.css";
import { label } from "./labels";

/** "2 fur, 1 bone", in the catalogue's order. */
export function resourceText(resources: Resources): string {
  return RESOURCE_KINDS.filter((k) => resources[k]).map((k) => `${resources[k]} ${label("resource", k).toLowerCase()}`).join(", ");
}

export const blueprintName = (id: string) => label("furnishing", id);
export const isTrophy = (f: FurnishingGrant) => FURNISHINGS[f.defId]?.kind === "trophy";

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

/** Gold and materials as small icon-and-count chips (the name is the tooltip): a contract's pay, what a workshop visitor holds. With `zeros`, kinds given as 0 still show. */
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

/** What a hero brings home for their hut. Renders nothing if there is nothing. */
export function HutSpoils({ earned }: { earned: Earned }) {
  const resources = earned.resources ?? {};
  const blueprints = earned.blueprints ?? [];
  const furnishings = earned.furnishings ?? [];
  if (Object.keys(resources).length === 0 && blueprints.length === 0 && furnishings.length === 0) return null;
  return (
    <div className="hut-spoils">
      <h4>For your hut</h4>
      <ResourceChips resources={resources} />
      {(blueprints.length > 0 || furnishings.length > 0) && (
        <ul>
          {furnishings.map((f, i) => (
            <li key={`f${i}`} className="with-icon">
              <ThingIcon icon={furnishingIcon(f.defId)} size={27} />
              <span className="grow">
                <span className="tag">{isTrophy(f) ? "Trophy" : "Decor"}</span> <strong>{f.label}</strong>
                {isTrophy(f) && <span className="muted"> · {label("furnishing", f.defId)}</span>}
              </span>
            </li>
          ))}
          {blueprints.map((id, i) => (
            <li key={`b${i}`} className="with-icon"><BlueprintIcon defId={id} size={27} /><span className="grow"><span className="tag">Blueprint</span> <strong>{blueprintName(id)}</strong></span></li>
          ))}
        </ul>
      )}
    </div>
  );
}

const PERK_TEXT: [keyof Perk, (n: number) => string][] = [
  ["focus", (n) => `+${n} focus`],
  ["potions", (n) => `+${n} potion${n === 1 ? "" : "s"}`],
  ["maxHp", (n) => `+${n} max HP`],
  ["xpPct", (n) => `+${n}% XP`],
];

/** "+1 focus, +1 potion" for the perks that are above zero, or "" if none are. */
export function perkText(perk: Perk | undefined): string {
  return PERK_TEXT.filter(([key]) => (perk?.[key] ?? 0) > 0).map(([key, text]) => text(perk![key]!)).join(", ");
}

const PERK_NAME: Record<keyof Perk, string> = { focus: "Focus", potions: "Potions", maxHp: "Max HP", xpPct: "XP" };

/** A hut's perks against the most any hut can give, one row each. */
export function PerkMeter({ perks }: { perks: Required<Perk> }) {
  return (
    <ul className="perk-meter">
      {PERK_TEXT.map(([key]) => (
        <li key={key} className={perks[key] >= PERK_CAPS[key] ? "full" : perks[key] > 0 ? "some" : "none"}>
          <span>{PERK_NAME[key]}</span>
          <span>+{perks[key]}{key === "xpPct" ? "%" : ""} <span className="muted">of +{PERK_CAPS[key]}{key === "xpPct" ? "%" : ""}</span></span>
        </li>
      ))}
    </ul>
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
