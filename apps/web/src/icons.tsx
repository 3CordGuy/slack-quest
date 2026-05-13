// RPG-Awesome icon helper. The web app drops emoji in favor of the icon
// font from https://nagoshiashumari.github.io/Rpg-Awesome/.
//
// Two ways to render:
//   <Icon name="sword" />            — direct lookup of an ra-* class
//   <EmojiIcon emoji="⚔️" />        — translates an emoji to its mapped ra-*
//                                      class; renders the original emoji if
//                                      no mapping is registered.
//
// Inline log strings often contain emoji embedded in template literals; for
// those we either flip the surrounding code to JSX or keep the emoji.
import type { CSSProperties } from "react";

interface IconProps {
  name: string;             // e.g. "sword" → renders className "ra ra-sword"
  size?: number | string;   // px or any css length; sets font-size
  color?: string;
  className?: string;
  style?: CSSProperties;
  spin?: boolean;
  fw?: boolean;             // fixed-width — useful for buttons / grids
  title?: string;
}

export function Icon({
  name,
  size,
  color,
  className,
  style,
  spin,
  fw,
  title,
}: IconProps): JSX.Element {
  const classes = [
    "ra",
    `ra-${name}`,
    spin ? "ra-spin" : null,
    fw ? "ra-fw" : null,
    className ?? null,
  ].filter(Boolean).join(" ");
  return (
    <i
      className={classes}
      aria-hidden={title ? undefined : true}
      title={title}
      style={{
        fontSize: typeof size === "number" ? `${size}px` : size,
        color,
        lineHeight: 1,
        verticalAlign: "middle",
        ...style,
      }}
    />
  );
}

// Curated emoji → ra-* mapping for the bits of the UI that still get emoji
// as raw text (log entries, ability headlines). When the emoji doesn't have
// a clean RPG-Awesome equivalent the entry is null, and EmojiIcon falls
// back to rendering the emoji literally.
const EMOJI_MAP: Record<string, string | null> = {
  // Equipment + actions
  "⚔️": "sword",
  "⚔": "sword",
  "🛡️": "shield",
  "🛡": "shield",
  "🔮": "crystal-ball",
  "✨": "fairy-wand",
  "🧪": "bubbling-potion",
  "💚": "health-increase",
  "💖": "crowned-heart",
  "🎒": "ammo-bag",
  "🔧": "anvil",
  "📜": "scroll-unfurled",
  "🪙": "gold-bar",
  "🎯": "targeted",
  "🏃": "footprint",
  "⏸": "hourglass",
  "💀": "death-skull",
  "🏆": "trophy",
  "📦": "cubes",
  "🏹": "crossbow",
  // Status / class
  "🌿": "grass",
  "🗡": "plain-dagger",
  "🧙": "crystal-wand",
  "🎵": null,                // no music icon — keep emoji
  "🥉": null,                // medals — colored ra-key below
  "🥈": null,
  "🥇": null,
  "🛏": "campfire",
  "🛌": "campfire",
  "💢": "fire-symbol",
  "💥": "blast",
  "🎲": "perspective-dice-six",
  "✅": "crossed-swords",
  "❌": "x-mark",
  "✦": "fairy",
  "▶": null,
  "🩸": "bleeding-hearts",
  "🔥": "fire",
  "☠️": "monster-skull",
  "☠": "monster-skull",
  "🟢": "aura",
  "🍂": "leaf",
};

// Inline replacement: renders an icon for any emoji in EMOJI_MAP, falls
// through to the literal emoji otherwise. Use when emoji are baked into
// string templates and you can't easily branch in JSX.
export function EmojiIcon({
  emoji,
  size,
  color,
}: {
  emoji: string;
  size?: number | string;
  color?: string;
}): JSX.Element {
  const mapped = EMOJI_MAP[emoji];
  if (!mapped) return <span>{emoji}</span>;
  return <Icon name={mapped} size={size} color={color} />;
}

// Tier-colored key icon — replaces 🥉/🥈/🥇.
export function KeyIcon({
  tier,
  size,
}: {
  tier: "bronze" | "silver" | "gold";
  size?: number | string;
}): JSX.Element {
  const color = tier === "gold" ? "#fbbf24" : tier === "silver" ? "#d1d5db" : "#b45309";
  return <Icon name="key" color={color} size={size} />;
}
