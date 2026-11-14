import { useEffect, useRef } from "react";

/**
 * Run `fn` when `key` is pressed (either case), while `enabled`. Ignored while typing in a field, with a modifier held,
 * or when a key repeats from being held down, so a chat message with an "i" in it never opens anything.
 */
export function useHotkey(key: string, fn: () => void, enabled = true) {
  const latest = useRef(fn);
  latest.current = fn;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.repeat || e.metaKey || e.ctrlKey || e.altKey || e.key.toLowerCase() !== key) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      latest.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [key, enabled]);
}
