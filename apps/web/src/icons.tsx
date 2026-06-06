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
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { CSSProperties } from "react";

// Icons with local SVG files in /icons/. These render as <img> instead of
// the ra- font, which gives crisper rendering at all sizes.
const SVG_ICONS = new Set([
  "anvil", "bolt-shield", "broadsword", "coffee-mug", "conversation",
  "crossbow", "crowned-heart", "crystal-wand", "cubes", "cycle", "daggers",
  "fairy-wand", "gold-bar", "helmet", "hood", "key", "perspective-dice-six",
  "plain-dagger", "revolver", "round-shield", "scythe", "shield",
  "spinning-sword", "trident", "trophy", "bed", "bathtub", "cash",
  // Close-match remaps (original ra- name → this SVG file)
  "battle-axe", "barbed-spear", "boots", "beer-stein", "lightning-saber",
  "blunderbuss", "poison-bottle", "arcing-bolt", "wax-seal",
  // Item slot icons
  "armored-pants", "heavy-helm", "hand", "ring", "gem-chain", "chest-armor", "gloves",
  // Loot / containers
  "chest",
  // Derived-stat icons
  "sword-brandish", "wizard-staff", "target-poster", "coffee-cup", "dodge", "dodging",
  // Action-button icons
  "run",
  // Status effect icons
  "ice-bolt", "electric", "bleeding-wound", "poison-cloud",
  // Victory modal icons
  "health-normal", "health-decrease", "health-potion", "death-skull", "party-popper", "party-flags",
  // Consumable icons
  "potion-ball",
  // Weapon icons
  "hammer-drop", "cannon", "cannon-shot", "shotgun", "musket", "rifle", "pistol-gun", "flail",
  "katana", "machete", "gladius",
  // Bard ability icons
  "music-spell", "morbid-humour",
  // Class ability icons (registered as SVG for crisp rendering)
  "aura", "axe-swing", "crystal-ball", "fire", "grass", "linked-rings",
  "scroll-unfurled", "shield-reflect",
  // Engineering-themed ability icons
  "cloud-upload", "crossed-chains", "firewall", "cloak-dagger", "spawn-node",
  "stack", "convergence-target", "database", "virus", "cpu-shot", "energy-shield",
  "brute", "vintage-robot", "muscle-up", "scroll-quill", "health-increase", "knocked-out-stars", "flame-spin", "first-aid-kit",
  "icicles-fence", "sound-on", "cracked-disc", "screaming", "blood", "heart-drop", "lightning-branches", "shieldcomb",
  // Climb the Tower
  "tower-flag",
  // My Camp + pub cooking (gathering nodes, ward tile, fish display)
  "camping-tent", "ore", "grass-mushroom", "fishing-hook", "fish-bucket", "fish-cooked", "eel", "salmon",
  // Camp stockpile resource icons
  "coal-pile", "crystal-bars", "crystal-cluster",           // ore tier: iron / silver / mithril
  "herbs-bundle", "chestnut-leaf", "dandelion-flower",      // herb tier: mossroot / sunleaf / nightbloom
  // Forage mini-game cells ("places in the forest")
  "fruit-tree", "stone-rock", "snake-tongue", "super-mushroom", "tree-roots",
  "flying-trout",                                           // fish tier: silverfin (eel+salmon already above)
  // Camp upgrade icons
  "wood-frame", "wooden-crate",
  // Inventory
  "knapsack",
  // User menu trigger
  "cog",
  // Talent-tree new ability icons (migration 0062)
  "frozen-arrow", "magnifying-glass", "tombstone", "musical-notes", "trash-can", "stopwatch",
  // Talent-tree icon-duplicate audit — sky-themed swaps
  "firework-rocket", "umbrella", "parachute", "flower-twirl", "swan-breeze",
  "swirl-ring", "lightning-storm", "snowing", "fluffy-trefoil", "dust-cloud",
  "fog", "cursed-star", "crossed-air-flows", "cloud-ring", "stomp-tornado",
  // Abstract fallback icons (used when no specific icon exists)
  "abstract-006",
]);

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
  const cssSize = typeof size === "number" ? `${size}px` : size;

  if (SVG_ICONS.has(name)) {
    // Use CSS mask-image so background-color becomes the icon color.
    // This gives pixel-perfect color via any CSS color value or currentColor.
    const dim = cssSize ?? "1em";
    return (
      <span
        aria-hidden={title ? undefined : true}
        title={title}
        style={{
          display: "inline-block",
          width: dim,
          height: dim,
          flexShrink: 0,
          verticalAlign: "middle",
          backgroundColor: color ?? "currentColor",
          maskImage: `url(/icons/${name}.svg)`,
          maskRepeat: "no-repeat",
          maskPosition: "center",
          maskSize: "contain",
          WebkitMaskImage: `url(/icons/${name}.svg)`,
          WebkitMaskRepeat: "no-repeat",
          WebkitMaskPosition: "center",
          WebkitMaskSize: "contain",
          ...(spin ? { animation: "ra-spin 2s linear infinite" } : {}),
          ...style,
        }}
      />
    );
  }

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
        fontSize: cssSize,
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
  "🎒": "knapsack",
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
  "🛏": "bed",
  "🛌": "bed",
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

// Unified avatar for player portraits and monster art.
// - src present: renders image with a magnifying-glass overlay on hover; click expands full-screen.
// - src absent / 404: renders a centered fallback icon in a styled box.
// Props:
//   src           — image URL (null/undefined → fallback)
//   alt           — accessible label
//   size          — square pixel dimension (default 56)
//   radius        — border-radius px (default 6)
//   fallbackIcon  — ra-* icon name (default "player")
//   fallbackColor — icon + border color (default "#4a5568")
//   border        — CSS border string applied to both states
//   style         — extra CSSProperties merged onto the outer container
export function Avatar({
  src,
  alt,
  size = 56,
  radius = 6,
  fallbackIcon = "player",
  fallbackColor = "#4a5568",
  fallbackSrc,
  border,
  style: extraStyle,
}: {
  src?: string | null;
  alt: string;
  size?: number;
  radius?: number;
  fallbackIcon?: string;
  fallbackColor?: string;
  fallbackSrc?: string | null;
  border?: string;
  style?: CSSProperties;
}): JSX.Element {
  const [failed, setFailed] = useState(false);
  const [fallbackFailed, setFallbackFailed] = useState(false);
  const [hovered, setHovered] = useState(false);
  const [open, setOpen] = useState(false);

  const activeSrc = !failed ? (src ?? null) : (!fallbackFailed && fallbackSrc) ? fallbackSrc : null;
  const showImage = !!activeSrc;

  const containerStyle: CSSProperties = {
    width: size,
    height: size,
    borderRadius: radius,
    flexShrink: 0,
    position: "relative",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    overflow: "hidden",
    border: border ?? "1px solid #2a2d33",
    background: showImage ? "transparent" : "#0e0f12",
    cursor: showImage ? "zoom-in" : "default",
    ...extraStyle,
  };

  // Close zoom on Esc. Local listener — only attaches while open so we don't
  // intercept Esc when the avatar's collapsed.
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") setOpen(false); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [open]);

  return (
    <>
      <div
        style={containerStyle}
        // stopPropagation so clicking the avatar doesn't also fire the
        // parent card's onClick (e.g. open-inventory). Without this, the
        // user gets both a zoom AND an inventory at once.
        onClick={(e) => { if (showImage) { e.stopPropagation(); setOpen(true); } }}
        onMouseEnter={() => { if (showImage) setHovered(true); }}
        onMouseLeave={() => setHovered(false)}
      >
        {showImage ? (
          <>
            <img
              src={activeSrc!}
              alt={alt}
              onError={() => { if (!failed) setFailed(true); else setFallbackFailed(true); }}
              style={{
                width: "100%",
                height: "100%",
                objectFit: "cover",
                display: "block",
                transition: "transform 0.15s ease",
                transform: hovered ? "scale(1.07)" : "scale(1)",
              }}
            />
            {hovered && (
              <div style={{
                position: "absolute",
                inset: 0,
                background: "rgba(0,0,0,0.35)",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                pointerEvents: "none",
              }}>
                <i className="ra ra-magnifying-glass" style={{ fontSize: 20, color: "#fff", opacity: 0.9 }} />
              </div>
            )}
          </>
        ) : (
          <i
            className={`ra ra-${fallbackIcon}`}
            aria-hidden
            style={{ fontSize: Math.round(size * 0.5), color: fallbackColor, lineHeight: 1 }}
          />
        )}
      </div>
      {open && typeof document !== "undefined" && createPortal(
        <div
          onClick={() => setOpen(false)}
          style={{
            position: "fixed",
            inset: 0,
            background: "rgba(0,0,0,0.88)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 9999,
            cursor: "zoom-out",
          }}
        >
          <img
            src={activeSrc!}
            alt={alt}
            style={{
              maxWidth: "min(90vw, 640px)",
              maxHeight: "85vh",
              borderRadius: 12,
              objectFit: "contain",
              boxShadow: "0 16px 48px rgba(0,0,0,0.8)",
            }}
          />
        </div>,
        document.body,
      )}
    </>
  );
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
