// Hut materials as the voyage and the inventory show them: feed wording, a
// row of resource counts, and the list on the ending screen.

import { FURNISHINGS, PERK_CAPS, RESOURCE_KINDS, RESOURCE_LABEL, type Earned, type FurnishingGrant, type Perk, type ResourceKind, type Resources } from "@gantt-quest/world";
import { Icon } from "./items";
import "./hutDrops.css";

/** Icon tint per resource; only the outline pass and cache key use it. */
const RESOURCE_COLOR: Record<ResourceKind, string> = {
  wood: "#8a5a2b",
  stone: "#8b95a5",
  iron: "#c9d1dc",
  copper: "#c8743a",
  fur: "#a0683a",
  bone: "#eee6cf",
  herbs: "#6fae4a",
  mushrooms: "#b8452f",
};

/** "2 fur, 1 bone", in the catalogue's order. */
export function resourceText(resources: Resources): string {
  return RESOURCE_KINDS.filter((k) => resources[k]).map((k) => `${resources[k]} ${RESOURCE_LABEL[k].toLowerCase()}`).join(", ");
}

export const blueprintName = (id: string) => FURNISHINGS[id]?.name ?? id;
export const isTrophy = (f: FurnishingGrant) => FURNISHINGS[f.defId]?.kind === "trophy";

/** One chip per resource. With `all`, kinds the player has none of are shown as zero. */
export function ResourceChips({ resources, all = false }: { resources: Resources; all?: boolean }) {
  return (
    <div className="res-chips">
      {RESOURCE_KINDS.filter((k) => all || resources[k]).map((k) => (
        <span key={k} className={`res-chip ${resources[k] ? "" : "none"}`} title={RESOURCE_LABEL[k]}>
          <Icon name={`res-${k}`} color={RESOURCE_COLOR[k]} size={22} />
          <strong>{resources[k] ?? 0}</strong>
          <span className="res-name">{RESOURCE_LABEL[k]}</span>
        </span>
      ))}
    </div>
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
            <li key={`f${i}`}>
              <span className="tag">{isTrophy(f) ? "Trophy" : "Decor"}</span> <strong>{f.label}</strong>
              {isTrophy(f) && <span className="muted"> · {FURNISHINGS[f.defId].name}</span>}
            </li>
          ))}
          {blueprints.map((id, i) => (
            <li key={`b${i}`}><span className="tag">Blueprint</span> <strong>{blueprintName(id)}</strong></li>
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
      {gold ? <span className={`cost ${(haveGold ?? 0) < gold ? "short" : ""}`} title={`You have ${haveGold ?? 0} gold`}><Icon name="cash" color="#ffd23f" size={16} /> {gold}g</span> : null}
      {RESOURCE_KINDS.filter((k) => cost[k]).map((k) => (
        <span key={k} className={`cost ${(have[k] ?? 0) < cost[k]! ? "short" : ""}`} title={`${RESOURCE_LABEL[k]}: you have ${have[k] ?? 0}`}>
          <Icon name={`res-${k}`} color={RESOURCE_COLOR[k]} size={16} /> {have[k] ?? 0}/{cost[k]}
        </span>
      ))}
    </span>
  );
}
