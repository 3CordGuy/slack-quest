import type { CSSProperties } from "react";

export const DISPLAY_FONT = "'Metamorphous', serif";

export const card: CSSProperties = {
  background: "#15171b",
  padding: "var(--card-pad, 32px)",
  borderRadius: 12,
  width: "100%",
  border: "1px solid #2a2d33",
  boxSizing: "border-box",
};

export const h1: CSSProperties = { margin: 0, fontSize: 28, color: "#f5f5f5", fontFamily: DISPLAY_FONT };
export const h2: CSSProperties = { margin: 0, fontSize: 20, color: "#f5f5f5", fontFamily: DISPLAY_FONT };
export const muted: CSSProperties = { color: "#9aa0a6", fontSize: 14 };

export const input: CSSProperties = {
  width: "100%",
  fontSize: 24,
  padding: "12px 14px",
  borderRadius: 8,
  border: "1px solid #2a2d33",
  background: "#0e0f12",
  color: "#f5f5f5",
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
  borderRadius: 8,
  border: "none",
  background: "#3a7bd5",
  color: "#fff",
  cursor: "pointer",
};

export const kbd: CSSProperties = {
  background: "#222428",
  padding: "2px 6px",
  borderRadius: 4,
  fontSize: 13,
};

export const refreshBtn: CSSProperties = {
  background: "none",
  border: "1px solid #2a2d33",
  borderRadius: 5,
  color: "#9ca3af",
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
  borderRadius: 4,
  border: "1px solid",
  fontWeight: 600,
};

export function smallActionBtn(bg: string, fg: string): CSSProperties {
  return {
    background: bg,
    color: fg,
    border: "1px solid #2a2d33",
    borderRadius: 6,
    padding: "4px 12px",
    fontSize: 12,
    fontWeight: 600,
    cursor: "pointer",
    fontFamily: "inherit",
  };
}
