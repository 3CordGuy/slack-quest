import { FloatingPortal } from "@floating-ui/react";
import { CLASSES, MAX_MANA_CAP_CEILING, maxManaCap, deriveMaxMana, statsAtLevel } from "@gantt-quest/core";
import { RARITY_COLOR } from "../constants";
import { Icon } from "../icons";

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section style={{ marginBottom: 28 }}>
      <div style={{
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        textTransform: "uppercase",
        letterSpacing: 1.2,
        color: "var(--fg-mute-2)",
        marginBottom: 10,
        borderBottom: "1px solid var(--border-faint)",
        paddingBottom: 6,
      }}>
        {title}
      </div>
      {children}
    </section>
  );
}

function Rule({ label, color = "var(--fg-2)", children }: { label: string; color?: string; children: React.ReactNode }) {
  return (
    <div style={{ display: "flex", gap: 10, marginBottom: 7, alignItems: "flex-start" }}>
      <div style={{
        minWidth: 110,
        fontSize: 11,
        fontFamily: "var(--font-mono)",
        color,
        paddingTop: 2,
        textAlign: "right",
      }}>
        {label}
      </div>
      <div style={{ fontSize: 12, color: "var(--fg-3)", lineHeight: 1.6, flex: 1 }}>
        {children}
      </div>
    </div>
  );
}

function Formula({ children }: { children: React.ReactNode }) {
  return (
    <span style={{
      fontFamily: "var(--font-mono)",
      fontSize: 11,
      background: "var(--bg-input)",
      borderRadius: 4,
      padding: "1px 5px",
      color: "var(--fg-2)",
    }}>
      {children}
    </span>
  );
}

function ManaCapTable() {
  const rows: { levels: string; cap: number }[] = [];
  for (let l = 1; l <= 16; l += 3) {
    const cap = maxManaCap(l);
    const next = l + 2;
    rows.push({ levels: next >= 16 ? `L${l}+` : `L${l}–${next}`, cap });
  }
  return (
    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginTop: 4 }}>
      {rows.map(r => (
        <div key={r.levels} style={{
          background: "var(--bg-input)",
          borderRadius: 6,
          padding: "4px 10px",
          fontSize: 11,
          fontFamily: "var(--font-mono)",
          color: r.cap >= MAX_MANA_CAP_CEILING ? "#a78bfa" : "var(--fg-2)",
          border: `1px solid ${r.cap >= MAX_MANA_CAP_CEILING ? "#a78bfa44" : "var(--border-faint)"}`,
          textAlign: "center",
        }}>
          <div style={{ color: "var(--fg-mute-2)", fontSize: 9, marginBottom: 2 }}>{r.levels}</div>
          <div>{r.cap}</div>
        </div>
      ))}
    </div>
  );
}

function ClassManaTable() {
  const classes = CLASSES.filter(c => c.id !== "unknown");
  return (
    <div style={{ overflowX: "auto" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 11, fontFamily: "var(--font-mono)" }}>
        <thead>
          <tr>
            <th style={{ textAlign: "left", color: "var(--fg-mute-2)", padding: "3px 8px 6px 0", fontWeight: 400, borderBottom: "1px solid var(--border-faint)" }}>Class</th>
            <th style={{ textAlign: "center", color: "var(--fg-mute-2)", padding: "3px 6px 6px", fontWeight: 400, borderBottom: "1px solid var(--border-faint)" }}>INT</th>
            <th style={{ textAlign: "center", color: "var(--fg-mute-2)", padding: "3px 6px 6px", fontWeight: 400, borderBottom: "1px solid var(--border-faint)" }}>L1</th>
            <th style={{ textAlign: "center", color: "var(--fg-mute-2)", padding: "3px 6px 6px", fontWeight: 400, borderBottom: "1px solid var(--border-faint)" }}>L6</th>
            <th style={{ textAlign: "center", color: "var(--fg-mute-2)", padding: "3px 6px 6px", fontWeight: 400, borderBottom: "1px solid var(--border-faint)" }}>L12</th>
          </tr>
        </thead>
        <tbody>
          {classes.map(cls => {
            const s1 = statsAtLevel(cls.name, 1);
            const s6 = statsAtLevel(cls.name, 6);
            const s12 = statsAtLevel(cls.name, 12);
            const m1 = deriveMaxMana(s1.int_stat, 1);
            const m6 = deriveMaxMana(s6.int_stat, 6);
            const m12 = deriveMaxMana(s12.int_stat, 12);
            return (
              <tr key={cls.id}>
                <td style={{ padding: "4px 8px 4px 0", color: "var(--fg-2)" }}>{cls.name}</td>
                <td style={{ padding: "4px 6px", textAlign: "center", color: "#7dd3fc" }}>{s1.int_stat}</td>
                <td style={{ padding: "4px 6px", textAlign: "center", color: "var(--fg-3)" }}>{m1}</td>
                <td style={{ padding: "4px 6px", textAlign: "center", color: "var(--fg-3)" }}>{m6}</td>
                <td style={{ padding: "4px 6px", textAlign: "center", color: "var(--fg-3)" }}>{m12}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function RarityPill({ rarity }: { rarity: string }) {
  const color = RARITY_COLOR[rarity as keyof typeof RARITY_COLOR] ?? "var(--fg-mute-2)";
  return (
    <span style={{
      display: "inline-block",
      fontFamily: "var(--font-mono)",
      fontSize: 10,
      color,
      border: `1px solid ${color}44`,
      borderRadius: 4,
      padding: "1px 5px",
      marginRight: 3,
    }}>
      {rarity}
    </span>
  );
}

export function StatsRulebook({ onClose }: { onClose: () => void }) {
  return (
    <FloatingPortal>
      <div
        style={{
          position: "fixed",
          inset: 0,
          background: "rgba(0,0,0,0.75)",
          zIndex: 500,
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          padding: 16,
        }}
        onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
      >
        <div style={{
          width: "min(680px, 100%)",
          maxHeight: "calc(100vh - 32px)",
          overflowY: "auto",
          background: "#111214",
          border: "1px solid #2a2d33",
          borderRadius: 16,
          padding: "22px 24px",
          boxShadow: "0 18px 60px rgba(0,0,0,0.5)",
        }}>
          {/* Header */}
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 22 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <Icon name="scroll-quill" size={20} color="#a78bfa" />
              <div>
                <div style={{ fontSize: 18, fontFamily: "var(--font-display)", color: "var(--fg-1)" }}>Stats Rulebook</div>
                <div style={{ fontSize: 11, color: "var(--fg-mute-2)", marginTop: 2 }}>How your numbers work</div>
              </div>
            </div>
            <button
              onClick={onClose}
              style={{ background: "none", border: "none", color: "var(--fg-mute-2)", cursor: "pointer", fontSize: 18, lineHeight: 1, padding: "2px 6px" }}
            >
              ×
            </button>
          </div>

          {/* Primary Stats */}
          <Section title="Primary Stats">
            <Rule label="STR" color="#f87171">
              <strong style={{ color: "#f87171" }}>Attack modifier.</strong>{" "}
              <Formula>floor((STR − 5) / 2)</Formula> — added to every weapon damage roll.
              Below 5 is a penalty; at 5 it's 0; at 9 it's +2.
            </Rule>
            <Rule label="INT" color="#7dd3fc">
              <strong style={{ color: "#7dd3fc" }}>Magic modifier + mana pool.</strong>{" "}
              <Formula>floor((INT − 5) / 2)</Formula> added to spells and heals.
              Also sets your formula mana: <Formula>2 + floor((INT − 4) / 2)</Formula>.
            </Rule>
            <Rule label="VIT" color="#86efac">
              <strong style={{ color: "#86efac" }}>Max HP + passive armor.</strong>{" "}
              Max HP: <Formula>16 + 2×VIT + 2×level</Formula>.{" "}
              Armor bonus: <Formula>floor(max(0, VIT − 5) / 4)</Formula> — only activates above 5 VIT.
            </Rule>
            <Rule label="AGI" color="#34d399">
              <strong style={{ color: "#34d399" }}>Dodge + initiative.</strong>{" "}
              Dodge: <Formula>min(15%, (AGI − 5) × 1%)</Formula> — fully negates a hit.
              Initiative: <Formula>floor((AGI − 5) / 2)</Formula> added to your d6 roll.
            </Rule>
            <Rule label="DEX" color="#fbbf24">
              <strong style={{ color: "#fbbf24" }}>Crit chance.</strong>{" "}
              <Formula>max(0, (DEX − 5) × 1%)</Formula>, capped at 10%.
              A crit multiplies damage by 1.5×.
            </Rule>
          </Section>

          {/* Max HP */}
          <Section title="Max HP">
            <Rule label="formula">
              <Formula>base_hp + (level − 1) × 3 + equipment bonuses</Formula>.
              Each class has a different <code>base_hp</code>. You gain roughly 3 HP per level regardless of VIT, but VIT contributes directly via the max-HP formula above.
            </Rule>
            <Rule label="on level-up">
              HP is refilled to the new max whenever you gain a level.
            </Rule>
          </Section>

          {/* Max Mana */}
          <Section title="Max Mana">
            <Rule label="formula">
              Your max mana has two parts that add together:
              <ul style={{ margin: "6px 0 0", paddingLeft: 18, lineHeight: 1.8 }}>
                <li><strong style={{ color: "var(--fg-2)" }}>Formula mana</strong> — <Formula>2 + floor((INT − 4) / 2) + floor(level / 6)</Formula>. Grows automatically as you level or spend points in INT.</li>
                <li><strong style={{ color: "#a78bfa" }}>Crystal bonus</strong> — permanent bonus from using magic crystal items. Survives level-ups.</li>
              </ul>
            </Rule>
            <Rule label="crystal cap">
              Crystals can only push your <em>total</em> max mana up to a level-gated ceiling — the formula mana counts toward it. The cap rises every 3 levels:
              <ManaCapTable />
            </Rule>
            <Rule label="crystal items">
              <RarityPill rarity="common" />+1 &nbsp;
              <RarityPill rarity="uncommon" />+2 &nbsp;
              <RarityPill rarity="rare" />+3 &nbsp;
              <RarityPill rarity="epic" />+4 &nbsp;
              <RarityPill rarity="legendary" />+5
            </Rule>
            <Rule label="refill">
              Mana refills to max at quest start, when joining a party, and after a Hot Bath at the inn.
            </Rule>
            <Rule label="by class">
              Formula mana at L1, L6, L12 (no crystals):
              <div style={{ marginTop: 8 }}>
                <ClassManaTable />
              </div>
            </Rule>
          </Section>

          {/* Armor & Shield */}
          <Section title="Armor & Shield">
            <Rule label="gear armor">
              Body armor contributes its full power; helmet ½; pants ¼; shield (off-hand) full.
              Total is your combat shield pool — it absorbs hits before HP.
            </Rule>
            <Rule label="VIT armor">
              Passive bonus on top of gear: <Formula>floor(max(0, VIT − 5) / 4)</Formula>.
              At VIT 9 that's +1; at VIT 13 it's +2. Added to the same shield pool.
            </Rule>
            <Rule label="focus bonus">
              Equipping a focus weapon (wand/staff/orb) grants +10% magic resistance on top of any gear resistance.
            </Rule>
          </Section>

          {/* Combat */}
          <Section title="Combat">
            <Rule label="hit roll">
              Attacker rolls d20. On 20 (crit): damage × 1.5. Defender's dodge chance is checked first — a successful dodge fully negates the hit.
            </Rule>
            <Rule label="damage">
              <Formula>weapon_power + attack_mod</Formula> for physical;{" "}
              <Formula>spell_power + magic_mod</Formula> for magic. Reduced by target's armor (subtract armor value, min 1 damage).
            </Rule>
            <Rule label="initiative">
              Each combatant rolls <Formula>d6 + initiative_bonus</Formula> at the start of combat. Highest goes first; ties broken by class initiative base.
            </Rule>
            <Rule label="abilities">
              Active abilities cost 1–2 mana. You can use one per turn. Passive abilities apply automatically.
            </Rule>
          </Section>

          {/* Rarity */}
          <Section title="Rarity">
            <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>
              {(["common", "uncommon", "rare", "epic", "legendary"] as const).map(r => (
                <div key={r} style={{
                  background: "var(--bg-input)",
                  border: `1px solid ${RARITY_COLOR[r]}44`,
                  borderRadius: 8,
                  padding: "6px 12px",
                  fontSize: 11,
                  fontFamily: "var(--font-mono)",
                  color: RARITY_COLOR[r],
                  textTransform: "capitalize",
                }}>
                  {r}
                </div>
              ))}
            </div>
            <div style={{ fontSize: 11, color: "var(--fg-mute-2)", marginTop: 8, lineHeight: 1.6 }}>
              Higher rarity means higher base power rolls. Weapon/armor power also scales +2 per monster tier above 1.
            </div>
          </Section>

          {/* Leveling */}
          <Section title="Leveling">
            <Rule label="XP">
              Awarded after each combat. The amount scales with monster tier and is split proportionally by damage dealt. Even 0-damage support builds earn at least 1 XP.
            </Rule>
            <Rule label="level-up">
              HP refills to the new max. Formula mana recalculates (crystal bonus is preserved). You gain 1 free stat point to spend in STR, INT, VIT, AGI, or DEX.
            </Rule>
            <Rule label="skill checks">
              STR ≥ 8 → pass STR traps automatically. DEX ≥ 8 → pass DEX traps. INT ≥ 8 → pass INT traps.
            </Rule>
          </Section>
        </div>
      </div>
    </FloatingPortal>
  );
}
