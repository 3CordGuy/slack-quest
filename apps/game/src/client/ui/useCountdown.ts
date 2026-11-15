// Whole seconds left until a deadline, for turn timers.

import { useEffect, useState } from "react";

/** Whole seconds until `deadline` (epoch ms), re-rendering each second. Null when there is no deadline. */
export function useCountdown(deadline: number | null | undefined): number | null {
  const [, tick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);
  return deadline ? Math.max(0, Math.ceil((deadline - Date.now()) / 1000)) : null;
}
