// Changing how your hero looks, from their sheet or their wardrobe at home: the look builder from character creation (LookBuilder),
// over the game, with them in what they are wearing now. Saving tells whoever is listening (the Harbor) so
// everyone sees the new look; see LOOK_CHANGED.

import { useEffect, useState } from "react";
import { outfitOf, type Appearance, type PublicHero } from "@gantt-quest/world";
import { api } from "./api";
import { LookBuilder } from "./LookBuilder";

/** A window event sent once a hero's new look is saved, so a room they are in can show it to everyone. */
export const LOOK_CHANGED = "gq:look-changed";

export function ChangeLook({ hero, look: from, onClose, onSaved }: { hero: PublicHero; look: Appearance; onClose(): void; onSaved(): void }) {
  const [look, setLook] = useState<Appearance>(from);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // While it is open the bottom bar (the hotbar) is hidden: it would sit over the builder's footer (builder.css).
  useEffect(() => {
    document.body.classList.add("changing-look");
    return () => document.body.classList.remove("changing-look");
  }, []);

  // Escape closes this (and not the sheet under it), unless something in the builder used it, as the tattoo
  // editor does to put a selection down.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !e.defaultPrevented) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      await api.setAppearance(look);
      window.dispatchEvent(new Event(LOOK_CHANGED));
      onSaved();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save that look.");
      setSaving(false);
    }
  };

  return (
    <div className="look-dialog-backdrop" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="look-dialog panel" role="dialog" aria-modal="true" aria-label="Change your look">
        <header className="look-dialog-head">
          <h2>Change your look</h2>
          <button type="button" className="small" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>
        <LookBuilder classId={hero.classId} look={look} onChange={setLook} wearing={outfitOf(hero.gear)} />
        <footer className="look-dialog-foot">
          {error && <span className="error">{error}</span>}
          <button type="button" className="small" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <button type="button" className="primary" onClick={save} disabled={saving}>
            {saving ? "Saving…" : "Save look"}
          </button>
        </footer>
      </div>
    </div>
  );
}
