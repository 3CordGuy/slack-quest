// Who is in the pub's corner, worked out in the browser from the crew and the
// clock, the same way the server does (packages/world/src/salesman.ts). Used
// to stand the salesman in the room and to hint at them from the Harbor; what
// they sell, and every purchase, still comes from the server.
//
// Dev server only: `?salesman=curio` in the URL (or `window.__gqSalesman =
// "curio"` in the console) puts that salesman in right now. The server is told
// in a header and honours it in the dev server only.

import { useEffect, useState } from "react";
import { SALESMAN_SLOT_MS, nextSalesmanVisit, salesman, salesmanVisitAt, type SalesmanId, type SalesmanVisit } from "@gantt-quest/world";

const fromUrl = import.meta.env.DEV ? new URLSearchParams(location.search).get("salesman") : null;

export function forcedSalesman(): SalesmanId | null {
  if (!import.meta.env.DEV) return null;
  const forced = (globalThis as { __gqSalesman?: string }).__gqSalesman ?? fromUrl;
  return forced && salesman(forced) ? (forced as SalesmanId) : null;
}

export function visitAt(crewId: string | undefined, at: number): SalesmanVisit | null {
  if (!crewId) return null;
  const forced = forcedSalesman();
  if (forced) {
    const slot = Math.floor(at / SALESMAN_SLOT_MS);
    return { visit: slot, salesmanId: forced, startsAt: slot * SALESMAN_SLOT_MS, endsAt: (slot + 1) * SALESMAN_SLOT_MS };
  }
  return salesmanVisitAt(crewId, at);
}

/** The visitor now and the next one due, re-checked every minute so arrivals and departures show without a reload. */
export function useSalesman(crewId: string | undefined): { now: number; here: SalesmanVisit | null; next: SalesmanVisit | null } {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(id);
  }, []);
  const here = visitAt(crewId, now);
  return { now, here, next: here || !crewId ? null : nextSalesmanVisit(crewId, now) };
}
