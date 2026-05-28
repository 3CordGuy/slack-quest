import { useState } from "react";
import type { ReactNode } from "react";
import { Icon } from "../icons";
import type { ShopResponse, ShopItem, StapleItem, InnResponse, SmithyResponse, WeaponRange, Rarity, ApothecaryResponse } from "../types";
import { HAGGLE_LABEL } from "../constants";
import { card, h2, muted, DISPLAY_FONT, smallBadge, smallActionBtn } from "../styles";
import { itemIcon, itemIconColor, describeItemEffect, formatDuration } from "../utils";
import { LocationHero, Banner, RefreshButton, RestockButton, RarityBadge, SmallBadge } from "./ui";

// ─── ShopCard ─────────────────────────────────────────────────────────────────

export function ShopCard({
  shop,
  navOverlay,
  onBuy,
  onHaggle,
  onBuyStaple,
  onRefresh,
  onRestock,
}: {
  shop: ShopResponse;
  navOverlay?: ReactNode;
  onBuy: (id: number, name: string) => void;
  onHaggle: (id: number) => void;
  onBuyStaple: (id: string) => void;
  onRefresh: () => Promise<void>;
  onRestock?: () => Promise<void>;
}) {
  const hero = navOverlay
    ? <LocationHero src={shop.art_url} label="Shop" nav={navOverlay} />
    : <Banner src={shop.art_url ?? null} alt="Shop" />;
  if (shop.error === "mid_quest") {
    return (
      <div style={card}>
        {hero}
        {!navOverlay && <h2 style={h2}>Shop</h2>}
        <p style={muted}>The shopkeep is afraid of monsters. Finish the quest first.</p>
      </div>
    );
  }
  if (shop.error === "no_channel" || !shop.channel_id) {
    return (
      <div style={card}>
        {hero}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          {!navOverlay && <h2 style={{ ...h2, margin: 0 }}>Shop</h2>}
          <RefreshButton onRefresh={onRefresh} />
        </div>
        <p style={muted}>
          No shop channel yet — start a quest in Slack first so we know which channel's shop to show.
        </p>
      </div>
    );
  }
  if (shop.needs_restock) {
    return (
      <div style={card}>
        {hero}
        <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
          {!navOverlay && <h2 style={{ ...h2, margin: 0 }}>Shop</h2>}
          <RefreshButton onRefresh={onRefresh} />
        </div>
        <p style={muted}>The shopkeep's shelves are bare.</p>
        {onRestock && (
          <RestockButton onRestock={onRestock} />
        )}
        {shop.staples && shop.staples.length > 0 && (
          <StaplesSection staples={shop.staples} gold={shop.gold} onBuyStaple={onBuyStaple} />
        )}
      </div>
    );
  }
  const available = shop.stock.filter((s) => !s.bought_by);
  const capUsed = shop.purchases_this_cycle ?? 0;
  const cap = shop.purchase_cap ?? 2;
  const atCap = capUsed >= cap;
  return (
    <div style={card}>
      {hero}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ ...h2, margin: 0 }}>Shop</h2>
        <RefreshButton onRefresh={onRefresh} />
      </div>
      <p style={muted}>
        {available.length}/{shop.stock.length} items available · you have{" "}
        <strong style={{ color: "#fbbf24" }}>{shop.gold}g</strong> · {capUsed}/{cap} bought
        this cycle.
      </p>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {shop.stock.map((s) => (
          <ShopRow
            key={s.id}
            item={s}
            playerGold={shop.gold}
            playerLevel={shop.level ?? 1}
            atCap={atCap}
            onBuy={onBuy}
            onHaggle={onHaggle}
          />
        ))}
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Haggle is a free action (per item, once per cycle). Bards / Sages / Rogues get a
        bonus on the d6.
      </p>
      {shop.staples && shop.staples.length > 0 && (
        <StaplesSection staples={shop.staples} gold={shop.gold} onBuyStaple={onBuyStaple} />
      )}
    </div>
  );
}

// Always-in-stock potions — fixed prices, no buy cap, no haggle. Mirrors the
// slack "🧺 Always in stock" section. Buy buttons gate on gold balance.
function StaplesSection({
  staples,
  gold,
  onBuyStaple,
}: {
  staples: StapleItem[];
  gold: number;
  onBuyStaple: (id: string) => void;
}) {
  return (
    <div style={{ marginTop: 20 }}>
      <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
        <Icon name="bubbling-potion" /> Always in stock
      </div>
      <div style={{ display: "grid", gap: 8 }}>
        {staples.map((s) => {
          const canAfford = gold >= s.price;
          return (
            <div
              key={s.id}
              style={{
                padding: 12,
                background: "#1d1f23",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <div style={{ fontSize: 22 }}>{s.emoji}</div>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>{s.name}</div>
                <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{s.blurb}</div>
              </div>
              <div style={{ color: "#fbbf24", fontWeight: 600, fontVariantNumeric: "tabular-nums" }}>
                {s.price}g
              </div>
              <button
                onClick={() => onBuyStaple(s.id)}
                disabled={!canAfford}
                style={{
                  ...smallActionBtn(canAfford ? "#1f3a1f" : "#222428", canAfford ? "#86efac" : "#7a7d83"),
                  opacity: canAfford ? 1 : 0.6,
                  cursor: canAfford ? "pointer" : "not-allowed",
                }}
              >
                Buy
              </button>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// Shared item row used by both the shop and smithy stock.
// Handles icon, name, rarity/level/type badges, flavor text, and the Info panel.
// Pass shop-specific or smithy-specific action buttons via `actions`.
function StoreItemRow({
  item,
  playerLevel,
  headerRight,
  extraBadges,
  opacity,
  sold,
  actions,
}: {
  item: {
    item_name: string;
    item_type: string;
    item_subtype?: string | null;
    weapon_range?: WeaponRange | null;
    slot?: string | null;
    power: number;
    rarity: string;
    flavor?: string | null;
    level_req?: number | null;
    stat_bonus?: Record<string, number> | null;
  };
  playerLevel: number;
  headerRight?: ReactNode;
  extraBadges?: ReactNode;
  opacity?: number;
  sold?: boolean;
  actions?: ReactNode;
}) {
  const [showInfo, setShowInfo] = useState(false);
  const levelReq = item.level_req ?? Math.max(1, Math.ceil(item.power / 3));
  const underLevel = playerLevel < levelReq;
  return (
    <div style={{ padding: 12, background: "#1d1f23", borderRadius: 8, opacity: opacity ?? 1, position: "relative", overflow: "hidden" }}>
      {sold && (
        <div style={{
          position: "absolute", inset: 0,
          display: "flex", alignItems: "center", justifyContent: "center",
          pointerEvents: "none", zIndex: 2,
        }}>
          <span style={{
            transform: "rotate(-20deg)",
            fontSize: 42,
            fontWeight: 900,
            fontFamily: DISPLAY_FONT,
            color: "#ef444466",
            border: "4px solid #ef444455",
            borderRadius: 6,
            padding: "2px 14px",
            letterSpacing: 6,
            textTransform: "uppercase",
            userSelect: "none",
            lineHeight: 1.1,
          }}>
            SOLD
          </span>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <Icon name={itemIcon(item as Parameters<typeof itemIcon>[0])} size={24} color={itemIconColor(item as Parameters<typeof itemIconColor>[0]) ?? "#cbd5e1"} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <span style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>{item.item_name}</span>
            <RarityBadge rarity={item.rarity as Rarity} />
            {levelReq > 1 && (
              <span
                title={underLevel ? `Requires level ${levelReq} to equip — you're level ${playerLevel}` : `Requires level ${levelReq} to equip`}
                style={{
                  ...smallBadge,
                  borderColor: underLevel ? "#dc262688" : "#3a3d44",
                  color: underLevel ? "#fca5a5" : "#9ca3af",
                  background: underLevel ? "#7f1d1d22" : "transparent",
                }}
              >
                L{levelReq}{underLevel ? " ⚠" : ""}
              </span>
            )}
            {item.item_type === "weapon" && item.weapon_range === "ranged" && <SmallBadge>ranged</SmallBadge>}
            {item.item_type === "weapon" && item.weapon_range === "focus" && <SmallBadge>focus</SmallBadge>}
            {extraBadges}
          </div>
          {item.flavor && (
            <div style={{ ...muted, fontSize: 12, fontStyle: "italic", marginTop: 2 }}>
              {item.flavor}
            </div>
          )}
        </div>
        {headerRight}
      </div>
      {showInfo && (
        <div style={{ marginTop: 8, padding: "8px 10px", background: "#0e0f12", borderRadius: 6, border: "1px solid #2a2d33", color: "#cbd5e1", fontSize: 12 }}>
          {describeItemEffect(item)}
        </div>
      )}
      <div style={{ display: "flex", gap: 6, marginTop: 8, justifyContent: "flex-end" }}>
        <button onClick={() => setShowInfo((v) => !v)} style={smallActionBtn("#222428", "#cbd5e1")} aria-expanded={showInfo}>
          {showInfo ? "Hide" : "Info"}
        </button>
        {actions}
      </div>
    </div>
  );
}

function ShopRow({
  item,
  playerGold,
  playerLevel,
  atCap,
  onBuy,
  onHaggle,
}: {
  item: ShopItem;
  playerGold: number;
  playerLevel: number;
  atCap: boolean;
  onBuy: (id: number, name: string) => void;
  onHaggle: (id: number) => void;
}) {
  const [pressing, setPressing] = useState(false);
  const sold = !!item.bought_by;
  const canAfford = playerGold >= item.price;
  const canBuy = !sold && canAfford && !atCap;
  const canHaggle = !sold && !item.haggled;
  return (
    <StoreItemRow
      item={item}
      playerLevel={playerLevel}
      opacity={sold ? 0.5 : 1}
      sold={sold}
      headerRight={
        <div style={{ fontVariantNumeric: "tabular-nums", color: canAfford ? "#fbbf24" : "#c0392b", fontWeight: 600, fontSize: 13 }}>
          +{item.power} · {item.price}g
        </div>
      }
      extraBadges={item.haggled ? <SmallBadge>{HAGGLE_LABEL[item.haggled]}</SmallBadge> : undefined}
      actions={
        <>
          {!sold && canHaggle && (
            <button onClick={() => onHaggle(item.id)} style={smallActionBtn("#33363d", "#e6e6e6")}>
              Haggle
            </button>
          )}
          {!sold && (
            <button
              onClick={() => onBuy(item.id, item.item_name)}
              onPointerDown={() => canBuy && setPressing(true)}
              onPointerUp={() => setPressing(false)}
              onPointerLeave={() => setPressing(false)}
              disabled={!canBuy}
              style={{
                ...smallActionBtn(canBuy ? "#1f3a1f" : "#2a2d33", canBuy ? "#86efac" : "#6a7080"),
                transform: pressing ? "scale(0.92)" : "scale(1)",
                transition: "transform 0.08s",
              }}
            >
              {atCap ? "Cap reached" : !canAfford ? "Need more gold" : "Buy"}
            </button>
          )}
          {sold && <span style={{ ...muted, fontSize: 11, alignSelf: "center" }}>Sold.</span>}
        </>
      }
    />
  );
}

// ─── InnCard ──────────────────────────────────────────────────────────────────

export function InnCard({
  inn,
  navOverlay,
  onStay,
}: {
  inn: InnResponse;
  navOverlay?: ReactNode;
  onStay: (roomId: string) => void;
}) {
  const hero = navOverlay
    ? <LocationHero src={inn.art_url} label="The Inn" nav={navOverlay} />
    : <Banner src={inn.art_url ?? null} alt="The Inn" />;
  if (inn.error === "mid_quest") {
    return (
      <div style={card}>
        {hero}
        {!navOverlay && <h2 style={h2}>The Inn</h2>}
        <p style={muted}>The innkeep won't take questing parties. Finish the fight first.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      {hero}
      <h2 style={h2}>The Inn</h2>
      <p style={muted}>
        A small hearth crackles in the corner. The innkeep looks up. <em>"Room for the night?"</em>
      </p>
      <p style={{ ...muted, fontSize: 12, marginTop: 4 }}>
        HP {inn.hp}/{inn.max_hp} · Mana {inn.mana}/{inn.max_mana} ·{" "}
        <span style={{ color: "#fbbf24", fontWeight: 600 }}>{inn.gold}g</span>
      </p>
      <div style={{ display: "grid", gap: 8, marginTop: 12 }}>
        {inn.rooms.map((r) => {
          const wouldRefillHp = r.refills.hp && inn.hp < inn.max_hp;
          const wouldRefillMana = r.refills.mana && inn.mana < inn.max_mana;
          const useful = wouldRefillHp || wouldRefillMana;
          const canAfford = inn.gold >= r.price;
          const label = !useful
            ? `Already rested`
            : !canAfford
              ? `Need ${r.price}g`
              : `Stay — ${r.price}g`;
          return (
            <div
              key={r.id}
              style={{
                padding: 12,
                background: "#1d1f23",
                borderRadius: 8,
                display: "flex",
                alignItems: "center",
                gap: 12,
              }}
            >
              <Icon name={r.iconName} size={22} color="#cbd5e1" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>{r.name}</div>
                <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{r.blurb}</div>
              </div>
              <button
                onClick={() => onStay(r.id)}
                disabled={!useful || !canAfford}
                style={{
                  ...smallActionBtn(
                    useful && canAfford ? "#1f3a1f" : "#222428",
                    useful && canAfford ? "#86efac" : "#7a7d83",
                  ),
                  opacity: useful && canAfford ? 1 : 0.6,
                  cursor: useful && canAfford ? "pointer" : "not-allowed",
                }}
              >
                {label}
              </button>
            </div>
          );
        })}
      </div>
      <p style={{ ...muted, fontSize: 11, marginTop: 8 }}>
        Inn rest bypasses the 24h long-rest cooldown.
      </p>
    </div>
  );
}

// ─── SmithyCard ───────────────────────────────────────────────────────────────

export function SmithyCard({
  smithy,
  navOverlay,
  characterLevel,
  onSharpen,
  onRepair,
  onBuy,
}: {
  smithy: SmithyResponse;
  navOverlay?: ReactNode;
  characterLevel: number;
  onSharpen: (itemId: number, itemName: string, cost: number, verb: string) => void;
  onRepair: (cost: number) => void;
  onBuy: (stockId: number, itemName: string, price: number) => void;
}) {
  const hero = navOverlay
    ? <LocationHero src={smithy.art_url} label="The Smithy" nav={navOverlay} />
    : <Banner src={smithy.art_url ?? null} alt="The Smithy" />;
  if (smithy.error === "mid_quest") {
    return (
      <div style={card}>
        {hero}
        {!navOverlay && <h2 style={h2}>The Smithy</h2>}
        <p style={muted}>The smith won't take your steel mid-quest — wrap up the fight first.</p>
      </div>
    );
  }
  return (
    <div style={card}>
      {hero}
      <h2 style={h2}>The Smithy</h2>
      <p style={muted}>
        <em>"Bring me steel and gold. I'll make it sing."</em>
      </p>
      <p style={{ ...muted, fontSize: 12, marginTop: 4 }}>
        <span style={{ color: "#fbbf24", fontWeight: 600 }}>{smithy.gold}g</span>{" "}
        · each upgrade adds <strong>+1</strong>; capped at <strong>3</strong> per item.
      </p>
      {smithy.armorRepair && smithy.armorRepair.current < smithy.armorRepair.max && (() => {
        const r = smithy.armorRepair!;
        const pct = r.current / r.max;
        const canAfford = smithy.gold >= r.cost;
        return (
          <div style={{ marginTop: 12, padding: 12, background: "#1d1f23", borderRadius: 8, border: "1px solid #3b1515" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Icon name="shield" size={22} color="#ef4444" />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>Repair Armor</div>
                <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>
                  {r.current}/{r.max} armor remaining
                </div>
                <div style={{ height: 4, background: "#0e0f12", borderRadius: 2, overflow: "hidden", marginTop: 4 }}>
                  <div style={{ width: `${pct * 100}%`, height: "100%", background: "#6b7280", transition: "width 0.3s ease" }} />
                </div>
              </div>
              <button
                onClick={() => onRepair(r.cost)}
                disabled={!canAfford}
                style={{
                  ...smallActionBtn(canAfford ? "#3a1a1a" : "#222428", canAfford ? "#f87171" : "#7a7d83"),
                  opacity: canAfford ? 1 : 0.6,
                  cursor: canAfford ? "pointer" : "not-allowed",
                }}
              >
                {canAfford ? `Repair — ${r.cost}g` : `Need ${r.cost}g`}
              </button>
            </div>
          </div>
        );
      })()}
      {/* Forged & Ready — rotating armor stock */}
      {smithy.stock && smithy.stock.length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
            <span><Icon name="anvil" size={11} /> Forged &amp; Ready</span>
            {smithy.stockExpiresAt && (
              <span style={{ fontSize: 10, color: "#6b7280" }}>
                Restocks in {formatDuration(Math.max(0, smithy.stockExpiresAt - Date.now()))}
              </span>
            )}
          </div>
          <div style={{ display: "grid", gap: 8 }}>
            {smithy.stock.map((s) => {
              const canAfford = smithy.gold >= s.price;
              const meetsLevel = characterLevel >= s.level_req;
              const purchasable = canAfford && meetsLevel;
              const label = !meetsLevel ? `Lv ${s.level_req} required`
                : !canAfford ? `Need ${s.price}g`
                : `Buy — ${s.price}g`;
              return (
                <StoreItemRow
                  key={s.id}
                  item={s}
                  playerLevel={characterLevel}
                  headerRight={
                    <div style={{ fontVariantNumeric: "tabular-nums", color: canAfford ? "#fbbf24" : "#c0392b", fontWeight: 600, fontSize: 13 }}>
                      +{s.power} · {s.price}g
                    </div>
                  }
                  actions={
                    <button
                      onClick={() => onBuy(s.id, s.item_name, s.price)}
                      disabled={!purchasable}
                      style={{
                        ...smallActionBtn(purchasable ? "#1f3a1f" : "#222428", purchasable ? "#86efac" : "#7a7d83"),
                        opacity: purchasable ? 1 : 0.6,
                        cursor: purchasable ? "pointer" : "not-allowed",
                      }}
                    >
                      {label}
                    </button>
                  }
                />
              );
            })}
          </div>
        </div>
      )}

      {/* The Anvil — upgrade/tune equipped items */}
      <div style={{ marginTop: 20, borderTop: "1px solid #2a2d33", paddingTop: 16 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase", letterSpacing: 1.5, marginBottom: 8 }}>
          <Icon name="anvil" size={11} /> The Anvil
        </div>
        {smithy.items.length === 0 ? (
          <p style={muted}>
            Nothing equipped to work on. Equip a weapon or armor first, then come back.
          </p>
        ) : (
          <div style={{ display: "grid", gap: 8 }}>
            {smithy.items.map((it) => {
              const atCap = it.sharpens_count >= it.cap;
              const canAfford = smithy.gold >= it.cost;
              const remaining = it.cap - it.sharpens_count;
              const label = atCap
                ? `Maxed`
                : canAfford
                  ? `${it.verb.verb} +1 — ${it.cost}g`
                  : `Need ${it.cost}g`;
              const meter = "●".repeat(it.sharpens_count) + "○".repeat(remaining);
              return (
                <div
                  key={it.id}
                  style={{ padding: 12, background: "#1d1f23", borderRadius: 8, display: "flex", alignItems: "center", gap: 12 }}
                >
                  <Icon name={it.verb.iconName} size={22} color="#cbd5e1" />
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>
                      {it.item_name} <span style={{ color: "#fbbf24", fontWeight: 500 }}>+{it.power}</span>{" "}
                      <span style={{ ...muted, fontSize: 11 }}>{it.verb.stat}</span>
                    </div>
                    <div style={{ ...muted, fontSize: 12, marginTop: 2, fontVariantNumeric: "tabular-nums" }}>
                      {meter} ({it.sharpens_count}/{it.cap} {it.verb.noun})
                    </div>
                  </div>
                  <button
                    onClick={() => onSharpen(it.id, it.item_name, it.cost, it.verb.verb)}
                    disabled={atCap || !canAfford}
                    style={{
                      ...smallActionBtn(
                        !atCap && canAfford ? "#1f3a1f" : "#222428",
                        !atCap && canAfford ? "#86efac" : "#7a7d83",
                      ),
                      opacity: !atCap && canAfford ? 1 : 0.6,
                      cursor: !atCap && canAfford ? "pointer" : "not-allowed",
                    }}
                  >
                    {label}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── ApothecaryCard ───────────────────────────────────────────────────────────

export function ApothecaryCard({
  apothecary,
  navOverlay,
  selfId,
  onBuyStaple,
  onRevive,
  onSelfRevive,
  onRefresh,
}: {
  apothecary: ApothecaryResponse | null;
  navOverlay?: ReactNode;
  selfId: string;
  onBuyStaple: (stapleId: string) => void;
  onRevive: (targetUserId: string, targetName: string) => void;
  onSelfRevive: () => Promise<void>;
  onRefresh: () => Promise<void>;
}) {
  const hero = navOverlay
    ? <LocationHero src={apothecary?.art_url} label="Apothecary" nav={navOverlay} />
    : <Banner src={apothecary?.art_url ?? null} alt="Apothecary" />;

  if (!apothecary) {
    return (
      <div style={card}>
        {hero}
        <h2 style={h2}>Apothecary</h2>
        <p style={muted}>The apothecary is closed. Finish your quest first.</p>
      </div>
    );
  }

  if (apothecary.error === "mid_quest") {
    return (
      <div style={card}>
        {hero}
        {!navOverlay && <h2 style={h2}>Apothecary</h2>}
        <p style={muted}>The apothecary won't deal with you mid-quest. Wrap up the fight first.</p>
      </div>
    );
  }

  const downed = apothecary.downed.filter((d) => d.slack_user_id !== selfId);
  const isSelfDowned = apothecary.downed.some((d) => d.slack_user_id === selfId);

  return (
    <div style={card}>
      {hero}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
        <h2 style={{ ...h2, margin: 0 }}>Apothecary</h2>
        <RefreshButton onRefresh={onRefresh} />
      </div>
      <p style={muted}>
        <em>"Venom, vigor, or revival — I deal in all three."</em>
      </p>
      <p style={{ ...muted, fontSize: 12, marginTop: 4 }}>
        You have <strong style={{ color: "#fbbf24" }}>{apothecary.gold}g</strong>
        {apothecary.revive_count > 0 && (
          <> · <strong style={{ color: "#f472b6" }}>{apothecary.revive_count} revive{apothecary.revive_count !== 1 ? "s" : ""}</strong> in pack</>
        )}
      </p>

      {/* Maimed adventurers panel */}
      {(downed.length > 0 || isSelfDowned) && (
        <div style={{ marginTop: 20 }}>
          <div style={{ ...muted, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1.5, marginBottom: 8 }}>
            <Icon name="fall-down" /> Maimed Adventurers
          </div>
          {isSelfDowned && (() => {
            const sr = apothecary.self_revive ?? null;
            const timeLeftMs = sr ? sr.downed_until - Date.now() : 0;
            const hrs = Math.floor(timeLeftMs / 3600000);
            const mins = Math.floor((timeLeftMs % 3600000) / 60000);
            const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
            return (
              <div style={{
                padding: 14,
                background: "#1f0a0a",
                border: "1px solid #7f1d1d66",
                borderRadius: 10,
                marginBottom: 10,
              }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <Icon name="fall-down" size={18} color="#f87171" />
                  <strong style={{ color: "#fca5a5", fontSize: 14 }}>You are downed</strong>
                  <span style={{ ...muted, fontSize: 12, marginLeft: "auto" }}>{timeStr} remaining</span>
                </div>
                <p style={{ ...muted, fontSize: 12, margin: "0 0 10px" }}>
                  Wait it out, ask a companion with a revive item, or pay half your gold and half your level-{sr?.level ?? "?"} progress to get back on your feet now.
                </p>
                {sr && (
                  <>
                    <div style={{ display: "flex", gap: 12, fontSize: 13, color: "#e2e8f0", marginBottom: 10 }}>
                      <span><Icon name="gold-bar" size={12} color="#fbbf24" /> <strong style={{ color: "#fbbf24" }}>{sr.gold_cost}g</strong> <span style={muted}>/ {sr.available_gold}</span></span>
                      <span>✨ <strong style={{ color: "#a78bfa" }}>{sr.xp_cost} XP</strong> <span style={muted}>/ {sr.available_xp_in_level}</span></span>
                    </div>
                    <button
                      onClick={() => void onSelfRevive()}
                      style={{
                        ...smallActionBtn("#0a2010", "#86efac"),
                        padding: "8px 14px",
                        fontSize: 13,
                      }}
                    >
                      💎 Self-revive ({sr.gold_cost}g + {sr.xp_cost} XP)
                    </button>
                  </>
                )}
              </div>
            );
          })()}
          {downed.map((d) => {
            const timeLeftMs = d.downed_until - Date.now();
            const hrs = Math.floor(timeLeftMs / 3600000);
            const mins = Math.floor((timeLeftMs % 3600000) / 60000);
            const timeStr = hrs > 0 ? `${hrs}h ${mins}m` : `${mins}m`;
            const canRevive = apothecary.revive_count > 0;
            return (
              <div
                key={d.slack_user_id}
                style={{
                  padding: 12,
                  background: "#1a0a0a",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                  marginBottom: 6,
                  border: "1px solid #7f1d1d33",
                }}
              >
                <Icon name="fall-down" size={20} color="#f87171" />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 14 }}>{d.name}</div>
                  <div style={{ ...muted, fontSize: 12 }}>{d.class} · downed for {timeStr} more</div>
                </div>
                <button
                  onClick={() => onRevive(d.slack_user_id, d.name)}
                  disabled={!canRevive}
                  title={canRevive ? "Use a revive item to restore them to 50% HP" : "You need a revive item"}
                  style={{
                    ...smallActionBtn(canRevive ? "#2d1a3a" : "#222428", canRevive ? "#e879f9" : "#7a7d83"),
                    opacity: canRevive ? 1 : 0.5,
                    cursor: canRevive ? "pointer" : "not-allowed",
                  }}
                >
                  Revive
                </button>
              </div>
            );
          })}
          {downed.length === 0 && !isSelfDowned && null}
        </div>
      )}
      {apothecary.downed.length === 0 && (
        <div style={{ marginTop: 20 }}>
          <div style={{ ...muted, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1.5, marginBottom: 8 }}>
            <Icon name="fall-down" /> Maimed Adventurers
          </div>
          <p style={{ ...muted, fontSize: 13 }}>No adventurers are downed right now.</p>
        </div>
      )}

      {/* Apothecary staples */}
      <div style={{ marginTop: 20 }}>
        <div style={{ ...muted, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: 1.5, marginBottom: 8 }}>
          <Icon name="bubbling-potion" /> Concoctions
        </div>
        <div style={{ display: "grid", gap: 8 }}>
          {apothecary.staples.map((s) => {
            const canAfford = apothecary.gold >= s.price;
            const powerLine = s.effect === "poison_enemy"
              ? `${s.power} poison/tick × ${s.turns} turns`
              : s.effect === "regen_self"
                ? `${s.power} HP/tick × ${s.turns} turns`
                : `+25% damage × ${s.turns} turns`;
            return (
              <div
                key={s.id}
                style={{
                  padding: 12,
                  background: "#1d1f23",
                  borderRadius: 8,
                  display: "flex",
                  alignItems: "center",
                  gap: 12,
                }}
              >
                <div style={{ width: 36, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <Icon
                    name={s.effect === "poison_enemy" ? "vial" : s.effect === "regen_self" ? "health-increase" : "bubbling-potion"}
                    size={28}
                    color={s.effect === "poison_enemy" ? "#a3e635" : s.effect === "regen_self" ? "#4ade80" : "#c084fc"}
                  />
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontWeight: 600, color: "#f5f5f5", fontSize: 15, fontFamily: DISPLAY_FONT }}>{s.name}</div>
                  <div style={{ ...muted, fontSize: 12, marginTop: 2 }}>{s.blurb}</div>
                  <div style={{ color: "#86efac", fontSize: 11, marginTop: 3 }}>{powerLine}</div>
                </div>
                <div style={{ color: "#fbbf24", fontWeight: 600, fontVariantNumeric: "tabular-nums", flexShrink: 0 }}>
                  {s.price}g
                </div>
                <button
                  onClick={() => onBuyStaple(s.id)}
                  disabled={!canAfford}
                  style={{
                    ...smallActionBtn(canAfford ? "#1a2d1a" : "#222428", canAfford ? "#86efac" : "#7a7d83"),
                    opacity: canAfford ? 1 : 0.6,
                    cursor: canAfford ? "pointer" : "not-allowed",
                  }}
                >
                  Buy
                </button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
