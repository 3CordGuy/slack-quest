import type { CSSProperties } from "react";

export const DISPLAY_FONT = "var(--font-display)";

export const card: CSSProperties = {
  background: "var(--bg-card)",
  padding: "var(--card-pad, 32px)",
  borderRadius: "var(--radius-2xl)",
  width: "100%",
  border: "1px solid var(--border-base)",
  boxSizing: "border-box",
};

/** Same geometry as `card` but with frosted-glass background + blur.
 *  Use inside LocationModalWide sections that sit over an art backdrop. */
export const glassCard: CSSProperties = {
  background: "rgba(12, 14, 18, 0.72)",
  padding: "var(--card-pad, 32px)",
  borderRadius: "var(--radius-2xl)",
  width: "100%",
  border: "1px solid rgba(255,255,255,0.08)",
  boxSizing: "border-box",
  backdropFilter: "blur(10px) saturate(1.1)",
  WebkitBackdropFilter: "blur(10px) saturate(1.1)",
};

export const h1: CSSProperties = { margin: 0, fontSize: 28, color: "var(--fg-1)", fontFamily: "var(--font-display)" };
export const h2: CSSProperties = { margin: 0, fontSize: 20, color: "var(--fg-1)", fontFamily: "var(--font-display)" };
export const muted: CSSProperties = { color: "var(--fg-mute)", fontSize: 14 };

export const input: CSSProperties = {
  width: "100%",
  fontSize: 24,
  padding: "12px 14px",
  borderRadius: "var(--radius-lg)",
  border: "1px solid var(--border-base)",
  background: "var(--bg-void)",
  color: "var(--fg-1)",
  marginTop: 16,
  letterSpacing: 4,
  textAlign: "center",
  boxSizing: "border-box",
};

export const button: CSSProperties = {
  marginTop: 12,
  width: "100%",
  padding: "12px 14px",
  fontSize: 16,
  fontWeight: 600,
  borderRadius: "var(--radius-lg)",
  border: "none",
  background: "var(--accent-ink-blue-2)",
  color: "#fff",
  cursor: "pointer",
};

export const kbd: CSSProperties = {
  background: "var(--bg-input)",
  padding: "2px 6px",
  borderRadius: "var(--radius-sm)",
  fontSize: 13,
};

export const refreshBtn: CSSProperties = {
  background: "none",
  border: "1px solid var(--border-base)",
  borderRadius: 5,
  color: "var(--fg-mute-2)",
  cursor: "pointer",
  fontSize: 11,
  padding: "3px 8px",
  fontFamily: "inherit",
};

export const smallBadge: CSSProperties = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 1,
  padding: "2px 6px",
  borderRadius: "var(--radius-sm)",
  border: "1px solid",
  fontWeight: 600,
};

export function smallActionBtn(bg: string, fg: string): CSSProperties {
  return {
    background: bg,
    color: fg,
    border: "1px solid var(--border-base)",
    borderRadius: "var(--radius-md)",
    padding: "4px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
