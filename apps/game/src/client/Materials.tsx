// The inventory's Materials row: what the player holds for building and
// furnishing their hut. Loaded from the hut endpoint each time it is shown.

import { useEffect, useState } from "react";
import type { Resources } from "@gantt-quest/world";
import { api } from "./api";
import { ResourceChips } from "./hutDrops";

export function Materials() {
  const [resources, setResources] = useState<Resources | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    api.hut().then((hut) => live && setResources(hut.resources), () => live && setFailed(true));
    return () => {
      live = false;
    };
  }, []);
  return (
    <div className="materials" title="Hut materials, brought home from islands">
      <span className="materials-label">Materials</span>
      {failed ? <span className="muted">Could not load.</span> : <ResourceChips resources={resources ?? {}} all />}
    </div>
  );
}
