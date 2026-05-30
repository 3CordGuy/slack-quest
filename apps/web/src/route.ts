import type { TownSection } from "./types";

export type Route = {
  section: TownSection | null;
  sub: string | null;
};

const SECTION_TO_SLUG: Record<TownSection, string> = {
  job_board: "jobs",
  pub: "pub",
  shop: "shop",
  inn: "inn",
  smithy: "smithy",
  apothecary: "apothecary",
  hunt: "hunt",
  camp: "camp",
};

const SLUG_TO_SECTION: Record<string, TownSection> = Object.fromEntries(
  Object.entries(SECTION_TO_SLUG).map(([k, v]) => [v, k as TownSection]),
);

export function parseHash(hash: string): Route {
  const raw = (hash || "").replace(/^#\/?/, "").split("?")[0];
  if (!raw) return { section: null, sub: null };
  const [slug, sub] = raw.split("/");
  const section = SLUG_TO_SECTION[slug] ?? null;
  if (!section) return { section: null, sub: null };
  return { section, sub: sub ? decodeURIComponent(sub) : null };
}

export function toHash(route: Route): string {
  if (!route.section) return "";
  const slug = SECTION_TO_SLUG[route.section];
  return route.sub ? `#${slug}/${encodeURIComponent(route.sub)}` : `#${slug}`;
}

export function routesEqual(a: Route, b: Route): boolean {
  return a.section === b.section && a.sub === b.sub;
}
