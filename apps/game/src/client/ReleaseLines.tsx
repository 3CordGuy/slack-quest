// One release's notes as a list, a line each: "Felling: Chops cut a notch".
// The notice board and the "newer version" notice both show notes this way.

import type { ReleaseNote } from "../releases";

export function ReleaseLines({ notes, className }: { notes: readonly ReleaseNote[]; className?: string }) {
  return (
    <ul className={className}>
      {notes.map((n, i) => (
        <li key={i}>
          {n.area && <strong>{n.area}: </strong>}
          {n.text}
        </li>
      ))}
    </ul>
  );
}
