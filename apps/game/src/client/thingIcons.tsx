// Which pixel icon, in which accent colour, each non-gear thing is drawn
// with: hut materials and gold, pub fare, apothecary brews, galley dishes,
// furniture and
// trophies, blueprints. Every menu that lists one of these asks here, so a
// thing looks the same everywhere and an admin override of its icon (keyed
// by the icon name, see itemArt.ts) reaches every list at once.

import { FURNISHINGS, RESOURCE_KINDS, type ResourceKind, type Resources, type SalesGoods } from "@gantt-quest/world";
import { ITEM_ART_NAMES, blueprintArtUrl } from "./itemArt";
import { Icon } from "./items";

/** An icon by name and the accent colour it is drawn in. */
export interface IconRef {
  name: string;
  color: string;
}

const DRAWN = new Set(ITEM_ART_NAMES);
const drawn = (name: string, fallback: string) => (DRAWN.has(name) ? name : fallback);

export const GOLD_ICON: IconRef = { name: "cash", color: "#ffd23f" };

/** Icon tint per resource. The resource icons hardly use it; it keys the cache and the admin preview. */
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

export const resourceIcon = (kind: string): IconRef => ({ name: drawn(`res-${kind}`, "res-stone"), color: RESOURCE_COLOR[kind as ResourceKind] ?? "#8b95a5" });

/** The accent on each piece of pub fare: the tankard's crest, the bottle's label, the bowl's band. */
const PUB_ACCENT: Record<string, string> = { ale: "#b8452f", rum: "#e0b12e", stew: "#3f6fa8", pie: "#b8452f" };

export const pubIcon = (id: string): IconRef => ({ name: drawn(`pub-${id}`, "pub-ale"), color: PUB_ACCENT[id] ?? "#e0b12e" });

/** Each brew's colour: the liquid in the flask, the band on the jar. */
const BREW_ACCENT: Record<string, string> = { healing: "#4fbf5a", focus: "#5b8fd8", stoneskin: "#9a7fb8" };

export const brewIcon = (id: string): IconRef => ({ name: drawn(`brew-${id}`, "brew-healing"), color: BREW_ACCENT[id] ?? "#4fbf5a" });

/** The galley's dishes: the band on the chowder pot, the tag on the bundle of stores. */
const DISH_ACCENT: Record<string, string> = { chowder: "#3f6fa8", stores: "#b8452f" };

export const dishIcon = (id: string): IconRef => ({ name: drawn(`dish-${id}`, "dish-chowder"), color: DISH_ACCENT[id] ?? "#3f6fa8" });

/** The one painted detail on each piece: a cushion, a blanket, a jewel, the sand in the glass. */
const FURN_ACCENT: Record<string, string> = {
  table: "#b8452f",
  side_table: "#3f6fa8",
  desk: "#f1f5fa",
  chair: "#b8452f",
  rug: "#b8452f",
  lantern: "#e0b12e",
  hand_lantern: "#3f6fa8",
  banner: "#3f6fa8",
  bed: "#3f6fa8",
  chest: "#b8452f",
  storage_chest: "#4f8a3a",
  hearth: "#4a4e5c",
  fireplace: "#3f6fa8",
  bookshelf: "#9b59b6",
  books: "#9b59b6",
  workbench: "#8b95a5",
  weapon_rack: "#b8452f",
  dresser: "#3f6fa8",
  cupboard: "#b8452f",
  crate: "#b8452f",
  barrel: "#3f6fa8",
  candle: "#c8743a",
  candelabra: "#e0b12e",
  mug: "#4f8a3a",
  bottle: "#e0b12e",
  plate: "#3f6fa8",
  potted_herb: "#c9a3e6",
  mushroom_jar: "#b8452f",
  skull: "#b8452f",
  sea_chart: "#b8452f",
  hourglass: "#e0c070",
  writing_set: "#3f6fa8",
  coin_pile: "#f1f5fa",
  globe: "#e0b12e",
  ship_bottle: "#b8452f",
  shell_chimes: "#8fd0c8",
  trophy_relic: "#b8452f",
  trophy_token: "#3f6fa8",
  trophy_pelt: "#ffd23f",
  trophy_core: "#5fd3e0",
};

/** A furnishing's own icon, or (for a piece added since the art was drawn) a crate or a chalice. */
export function furnishingIcon(defId: string): IconRef {
  const fallback = FURNISHINGS[defId]?.kind === "trophy" ? "furn-trophy_relic" : "furn-crate";
  return { name: drawn(`furn-${defId}`, fallback), color: FURN_ACCENT[defId] ?? "#b8452f" };
}

/** Every icon the furnishings, pub, brews, dishes and resources use, with what uses it: for the admin page. */
export function thingIconUsers(): [icon: string, user: string][] {
  return [
    ...RESOURCE_KINDS.map((k) => [resourceIcon(k).name, `resource:${k}`] as [string, string]),
    ...Object.keys(PUB_ACCENT).map((id) => [pubIcon(id).name, `pub:${id}`] as [string, string]),
    ...Object.keys(BREW_ACCENT).map((id) => [brewIcon(id).name, `brew:${id}`] as [string, string]),
    ...Object.keys(DISH_ACCENT).map((id) => [dishIcon(id).name, `dish:${id}`] as [string, string]),
    ...Object.keys(FURNISHINGS).map((id) => [furnishingIcon(id).name, `furnishing:${id}`] as [string, string]),
  ];
}

/** A non-gear thing's icon. Sizes that are a multiple of 9 stay crisp on a high-density screen. */
export function ThingIcon({ icon, size = 36 }: { icon: IconRef; size?: number }) {
  return <Icon name={icon.name} color={icon.color} size={size} />;
}

/** A blueprint: the piece drawn in pale lines on squared blue paper. */
export function BlueprintIcon({ defId, size = 36 }: { defId: string; size?: number }) {
  return (
    <span className="blueprint-icon" style={{ width: size, height: size }}>
      <img className="pixel-icon" aria-hidden alt="" draggable={false} width={size} height={size} src={blueprintArtUrl(furnishingIcon(defId).name, "#e4f0ff")} />
    </span>
  );
}

/** What a traveling salesman's entry shows beside its name (gear has its own tile). */
export function GoodsIcon({ goods, materials, size = 36 }: { goods: SalesGoods; materials: Resources; size?: number }) {
  if (goods.kind === "blueprint") return <BlueprintIcon defId={goods.defId} size={size} />;
  if (goods.kind === "furnishing") return <ThingIcon icon={furnishingIcon(goods.defId)} size={size} />;
  const first = RESOURCE_KINDS.find((k) => materials[k]);
  return <ThingIcon icon={first ? resourceIcon(first) : GOLD_ICON} size={size} />;
}
