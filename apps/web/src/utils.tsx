import toast from "react-hot-toast";
import { findCatalogEntry } from "@gantt-quest/core";

import { Icon } from "./icons";
import { ERROR_LABELS, SLOT_LABELS, RARITY_RANK, ITEM_TYPE_ORDER, ART_PLACEHOLDERS, DEFAULT_ART_PLACEHOLDER } from "./constants";
import type { Item, ItemType, WeaponRange, EquipSlot, DrinkBuff, InventorySort } from "./types";

// ─── Portrait / slug helpers ─────────────────────────────────────────────────

export function adventurerSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "unnamed";
}

export function adventurerCharPortrait(name: string): string {
  return `/img/art/v3/character/${adventurerSlug(name)}.png`;
}

export function adventurerClassPortrait(className: string): string {
  return `/img/art/views/v6/class_${className.toLowerCase().replace(/[\s-]+/g, "_")}.png`;
}

// ─── Network ─────────────────────────────────────────────────────────────────

export async function postJson(
  url: string,
  init: RequestInit = {},
  opts: { skipErrorToast?: boolean } = {},
): Promise<{ ok: boolean; body: Record<string, unknown> | null }> {
  let res: Response;
  try {
    res = await fetch(url, { credentials: "include", ...init });
  } catch (err) {
    toast.error(`Network error: ${err instanceof Error ? err.message : String(err)}`);
    return { ok: false, body: null };
  }
  let body: Record<string, unknown> | null = null;
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    body = null;
  }
  if (!res.ok) {
    if (opts.skipErrorToast) return { ok: false, body };
    const code = typeof body?.error === "string" ? body.error : `http_${res.status}`;
    const message = ERROR_LABELS[code] ?? code;
    if (code === "cooldown" && typeof body?.ready_in_ms === "number") {
      const mins = Math.max(1, Math.ceil(body.ready_in_ms / 60_000));
      toast.error(`${message} (~${mins}m)`);
    } else {
      toast.error(message);
    }
    return { ok: false, body };
  }
  return { ok: true, body };
}

// ─── Item display helpers ─────────────────────────────────────────────────────

export function slotLabel(item: Item): string {
  if (item.slot) return SLOT_LABELS[item.slot];
  return item.item_type.charAt(0).toUpperCase() + item.item_type.slice(1);
}

export function statBonusSummary(bonus: Record<string, number> | null): string {
  if (!bonus) return "";
  return Object.entries(bonus)
    .filter(([, v]) => v !== 0)
    .map(([k, v]) => `+${v} ${k === "int_stat" ? "INT" : k.toUpperCase()}`)
    .join(", ");
}

export function itemIcon(item: {
  item_type: ItemType;
  weapon_range?: WeaponRange | null;
  item_name: string;
  slot?: EquipSlot | null;
  item_subtype?: string | null;
  flavor?: string | null;
}): string {
  const n = item.item_name.toLowerCase();
  const f = (item.flavor ?? "").toLowerCase();

  if (item.slot && item.slot !== "main_hand") {
    switch (item.slot) {
      case "off_hand":  return item.item_subtype === "gloves" ? "gloves" : "round-shield";
      case "body":      return "chest-armor";
      case "helmet":    return "heavy-helm";
      case "pants":     return "armored-pants";
      case "boots":     return "boots";
      case "ring":      return "ring";
      case "amulet":    return "gem-chain";
    }
  }

  switch (item.item_type) {
    case "weapon": {
      if (item.weapon_range === "focus") return "crystal-wand";
      if (/\bcannon(ball|shot)?\b/.test(n))                              return /\b(shot|ball)\b/.test(n) ? "cannon-shot" : "cannon";
      if (/\b(sawed-?off|shotgun)\b/.test(n))                            return "shotgun";
      if (/\bblunderbuss\b/.test(n) || /\bblunderbuss\b/.test(f))         return "blunderbuss";
      if (/\bmusket\b/.test(n))                                          return "musket";
      if (/\brifle\b/.test(n))                                           return "rifle";
      if (/\b(pistol|revolver|sidearm|six-?shooter)\b/.test(n))          return "pistol-gun";
      if (/\bgun\b/.test(f))                                              return "blunderbuss";
      if (/\bdaggers\b/.test(n))                                          return "daggers";
      if (/\b(axe|hatchet|cleaver|tomahawk)\b/.test(n))                  return "battle-axe";
      if (/\b(dagger|knife|dirk|shiv|stiletto|shank)\b/.test(n))         return "plain-dagger";
      if (/\b(hammer|sledge)\b/.test(n))                                 return "hammer-drop";
      if (/\b(flail|morning-?star|nunchaku|chain-?whip)\b/.test(n))      return "flail";
      if (/\b(maul|mace|club)\b/.test(n))                                return "hammer";
      if (/\b(staff|stave|wand|rod|scepter|sceptre)\b/.test(n))          return "crystal-wand";
      if (/\b(spear|lance|pike|javelin|halberd|polearm)\b/.test(n))      return "barbed-spear";
      if (/\bcrossbow\b/.test(n))                                         return "crossbow";
      if (/\b(bow|longbow|shortbow|recurve)\b/.test(n))                  return "crossbow";
      if (/\bgun\b/.test(n))                                              return "blunderbuss";
      if (/\b(scythe|sickle)\b/.test(n))                                 return "scythe";
      if (/\btrident\b/.test(n))                                         return "trident";
      if (/\bkatana\b/.test(n))                                          return "katana";
      if (/\bmachete\b/.test(n))                                         return "machete";
      if (/\bgladius\b/.test(n))                                         return "gladius";
      if (/\b(saber|sabre|rapier|foil|estoc|scimitar|cutlass|falchion)\b/.test(n)) return "spinning-sword";
      if (/\b(broadsword|greatsword|longsword|claymore|zweihander|bastard-?sword)\b/.test(n)) return "broadsword";
      if (item.weapon_range === "ranged")                                 return "crossbow";
      return "sword";
    }

    case "armor": {
      if (/\b(helm|helmet|cap|hat|crown|circlet|coif)\b/.test(n))       return "heavy-helm";
      if (/\b(hood|cowl)\b/.test(n))                                     return "hood";
      if (/\b(boot|shoe|greave|sabatons?|sandal)\b/.test(n))            return "boots";
      if (/\b(glove|gauntlet|bracer|vambrace)\b/.test(n))               return "hand";
      if (/\b(cloak|mantle|cape|robe|shroud|vestment|cassock)\b/.test(n)) return "hood";
      if (/\b(amulet|pendant|necklace|talisman|charm|locket)\b/.test(n)) return "gem-chain";
      if (/\b(ring|band)\b/.test(n))                                    return "ring";
      if (/\b(pant|leg|greave|legging|trouser)\b/.test(n))             return "armored-pants";
      if (/\b(shield|buckler|targe)\b/.test(n))                         return "round-shield";
      return "chest-armor";
    }

    case "consumable": {
      if (/\b(mushroom|fungi|fungus|shroom)\b/.test(n))                  return "super-mushroom";
      if (/\b(meat|chicken|drumstick|steak|food|ration|bread)\b/.test(n)) return "roast-chicken";
      if (/\b(herb|leaf|clover|root|petal|flower)\b/.test(n))           return "leaf";
      if (/\b(bandage|salve|poultice|balm|ointment)\b/.test(n))         return "medical-pack";
      if (/\b(elixir|essence|tincture|draught|brew)\b/.test(n))         return "heart-bottle";
      if (/\b(poison|venom|toxin)\b/.test(n))                           return "poison-bottle";
      if (/\b(mana|arcane|flask)\b/.test(n))                             return "potion-ball";
      if (/\b(health|healing|hp|cure|restore|remedy|revitaliz)\b/.test(n)) return "health-potion";
      return "bubbling-potion";
    }

    case "magic": {
      if (/\b(tome|book|grimoire|codex|manual)\b/.test(n))              return "book";
      if (/\b(rune|glyph|sigil)\b/.test(n))                             return "rune-stone";
      if (/\b(crystal|gem|jewel|prism)\b/.test(n))                      return "crystals";
      if (/\b(ring|band)\b/.test(n))                                    return "ring";
      if (/\b(amulet|pendant|necklace|talisman|charm|locket)\b/.test(n)) return "gem-chain";
      return "crystal-ball";
    }

    case "revive":
      return "crowned-heart";

    case "tool": {
      if (/caffeine bomb|hotfix grenade/.test(n))                        return "bomb-explosion";
      if (/espresso shot/.test(n))                                       return "coffee-mug";
      if (/poison vial/.test(n))                                         return "poison-bottle";
      if (/\b(bomb|explosive|grenade|nuke)\b/.test(n))                  return "bomb-explosion";
      if (/\b(torch|lantern|light)\b/.test(n))                          return "torch";
      if (/\b(rope|grapple|hook)\b/.test(n))                            return "grappling-hook";
      if (/\b(trap|snare|net)\b/.test(n))                               return "bear-trap";
      if (/\b(lockpick|picks?)\b/.test(n))                              return "key-basic";
      if (/\b(shovel|spade)\b/.test(n))                                 return "shovel";
      if (/\b(vial|flask|bottle)\b/.test(n))                            return "poison-bottle";
      return "anvil";
    }

    default:
      return "scroll-unfurled";
  }
}

export function itemIconColor(item: {
  item_type: ItemType;
  item_name: string;
}): string | null {
  const n = item.item_name.toLowerCase();
  if (item.item_type === "consumable" || item.item_type === "tool") {
    if (/\b(health|heal|hp|restore|mend|cure|potion|elixir|life)\b/.test(n)) return "#ef4444";
    if (/\b(mana|mp|arcane|magic|mystic|flask|vial)\b/.test(n))              return "#818cf8";
    if (/\bgreater\b/.test(n) && /\bhealth\b/.test(n))                       return "#ef4444";
  }
  return null;
}

export function sortItems(items: Item[], sort: InventorySort): Item[] {
  return [...items].sort((a, b) => {
    switch (sort) {
      case "type": {
        const ti = ITEM_TYPE_ORDER.indexOf(a.item_type) - ITEM_TYPE_ORDER.indexOf(b.item_type);
        if (ti !== 0) return ti;
        return RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity];
      }
      case "rarity":
        return RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity] || a.item_name.localeCompare(b.item_name);
      case "power":
        return b.power - a.power || RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity];
      case "lvl": {
        const al = a.level_req ?? 1;
        const bl = b.level_req ?? 1;
        return bl - al || RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity] || a.item_name.localeCompare(b.item_name);
      }
    }
  });
}

export function groupByType(items: Item[]): Partial<Record<ItemType, Item[]>> {
  const out: Partial<Record<ItemType, Item[]>> = {};
  for (const it of items) {
    (out[it.item_type] ??= []).push(it);
  }
  for (const t of Object.keys(out) as ItemType[]) {
    out[t]!.sort((a, b) => RARITY_RANK[b.rarity] - RARITY_RANK[a.rarity]);
  }
  return out;
}

export function artPlaceholder(key: string) {
  if (ART_PLACEHOLDERS[key]) return ART_PLACEHOLDERS[key];
  for (const [k, v] of Object.entries(ART_PLACEHOLDERS)) {
    if (key.includes(k)) return v;
  }
  return DEFAULT_ART_PLACEHOLDER;
}

// ─── Pub helpers ──────────────────────────────────────────────────────────────

export function drinkBuffLabel(buff: DrinkBuff): string {
  if (buff.kind === "buff_attack") return `+${buff.magnitude} attack`;
  if (buff.kind === "buff_magic") return `+${buff.magnitude} magic`;
  return "next attack/cast/sig crits";
}

// ─── Date / time ─────────────────────────────────────────────────────────────

export function formatDuration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function formatRelative(ts: number): string {
  const diff = Date.now() - ts;
  const min = 60_000;
  const hour = 60 * min;
  const day = 24 * hour;
  if (diff < min) return "just now";
  if (diff < hour) return `${Math.floor(diff / min)}m ago`;
  if (diff < day) return `${Math.floor(diff / hour)}h ago`;
  if (diff < 30 * day) return `${Math.floor(diff / day)}d ago`;
  return new Date(ts).toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
  });
}

// ─── Item description (JSX) ───────────────────────────────────────────────────

export function describeItemEffect(item: {
  item_type: string;
  power: number;
  weapon_range?: "melee" | "ranged" | "focus" | null;
  item_name: string;
  slot?: string | null;
  item_subtype?: string | null;
  stat_bonus?: Record<string, number> | null;
}): React.ReactNode {
  const p = item.power;
  const lead = (name: string) => <Icon name={name} style={{ marginRight: 6 }} />;
  const statLine = item.stat_bonus ? statBonusSummary(item.stat_bonus) : "";
  switch (item.item_type) {
    case "weapon":
      if (item.weapon_range === "focus") {
        return <>{lead("crystal-ball")}Focus weapon: adds +{p} to heal & shield rolls (no attack/cast damage). +1 max mana while equipped.</>;
      }
      if (item.weapon_range === "ranged") {
        return <>{lead("crossbow")}Ranged weapon: +{p} attack/cast damage. Can attack from back row.</>;
      }
      return <>{lead("sword")}Melee weapon: +{p} attack/cast damage. Front row only for attack.</>;
    case "armor": {
      const slot = item.slot;
      if (slot === "boots" || slot === "ring" || slot === "amulet") {
        return <>{lead(slot === "boots" ? "boots" : slot === "ring" ? "ring" : "gem-chain")}{statLine || "Passive stat bonus."}</>;
      }
      if (slot === "off_hand" && item.item_subtype === "gloves") {
        const gloveArmor = Math.floor(p / 3);
        return <>{lead("gloves")}Gloves: contributes {p > 0 ? `+${gloveArmor} to armor pool` : "no armor"}{statLine ? `. ${statLine}` : "."}</>;
      }
      if (slot === "off_hand") {
        return <>{lead("shield")}Shield: adds +{p} to armor pool{statLine ? `. ${statLine}` : "."}</>;
      }
      if (slot === "helmet") {
        return <>{lead("heavy-helm")}Helmet: contributes floor({p}/2) = {Math.floor(p / 2)} to armor pool{statLine ? `. ${statLine}` : "."}</>;
      }
      if (slot === "pants") {
        return <>{lead("armored-pants")}Pants: contributes floor({p}/4) = {Math.floor(p / 4)} to armor pool{statLine ? `. ${statLine}` : "."}</>;
      }
      return <>{lead("chest-armor")}Armor: reduces incoming damage by {Math.max(1, Math.floor(p / 2))}{statLine ? `. ${statLine}` : "."}</>;
    }
    case "consumable": {
      const cEntry = findCatalogEntry(item.item_name);
      if (cEntry?.effect === "restore_mana") return <>{lead("potion-ball")}Restores {p} mana on use. Single-use.</>;
      return <>{lead("bubbling-potion")}Restores {p} HP on use. Single-use.</>;
    }
    case "magic":
      return <>{lead("crystal-ball")}Permanently grants +{p} max mana on use (capped at 5).</>;
    case "revive":
      return <>{lead("crowned-heart")}Revives a downed party member to {p}% of their max HP. Combat-only.</>;
    case "tool":
    case "scroll": {
      const entry = findCatalogEntry(item.item_name);
      const base = entry?.blurb ?? "Catalog item.";
      const powerNote = p > 0 ? ` (power ${p})` : "";
      return <>{lead(item.item_type === "scroll" ? "scroll-unfurled" : "anvil")}{base}{powerNote}</>;
    }
    default:
      return <>Item: +{p}.</>;
  }
}
