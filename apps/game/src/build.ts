// Which build this code came from.
//
// vite.config.ts stamps one id into every build, and the client and the Worker
// are built together, so the two halves of a deployment carry the same id. A
// tab left open keeps the id it loaded with; the Worker answers /api/version
// with the id now deployed. When they differ the tab is running an old build
// and says so (client/NewVersion.tsx).
//
// The dev server and the tests are stamped "dev" (or not at all), so nothing
// there ever looks out of date.

declare const __GQ_BUILD__: string | undefined;

export const BUILD_ID: string = typeof __GQ_BUILD__ === "string" ? __GQ_BUILD__ : "dev";

/** True when a tab stamped `mine` is not the build the server says is deployed. An unknown answer is not stale. */
export function isStale(mine: string, deployed: unknown): boolean {
  return typeof deployed === "string" && deployed !== "" && deployed !== mine;
}
