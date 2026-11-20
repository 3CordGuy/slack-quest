// Worker entry for the game: the HTTP API (accounts, characters, inventory,
// the Harbor's shops and pastimes, the atlas) and the WebSocket routes into
// the Durable Objects: a crew's Harbor and pub, a hut, and each zone.
//
// The routes themselves are in server/routes/, a module to each feature.
// Each exports a function that registers its routes on the app, and they
// are called here in order. The order matters: a middleware covers only
// what is registered after it. A new feature gets its own module and one
// more call below.

import { Hono } from "hono";
import { atlasRoutes } from "./server/routes/atlas";
import { characterRoutes } from "./server/routes/character";
import { chestRoutes } from "./server/routes/chest";
import { contentRoutes } from "./server/routes/content";
import { crewRoutes } from "./server/routes/crew";
import { devRoutes } from "./server/routes/dev";
import { fishRoutes } from "./server/routes/fish";
import { gatherRoutes } from "./server/routes/gather";
import { hutRoutes } from "./server/routes/huts";
import { keeperRoutes } from "./server/routes/keepers";
import { lapidaryRoutes } from "./server/routes/lapidary";
import { meRoutes } from "./server/routes/me";
import { projectRoutes } from "./server/routes/projects";
import { pubRoutes } from "./server/routes/pub";
import { releaseRoutes, versionRoutes } from "./server/routes/releases";
import { signInRoutes, signedInOnly } from "./server/routes/session";
import type { AppEnv } from "./server/routes/shared";
import { stallRoutes } from "./server/routes/stall";
import { tradeRoutes } from "./server/routes/trade";
import { zoneRoutes } from "./server/routes/zones";

export { HarborRoom } from "./server/harbor-room";
export { HutRoom } from "./server/hut-room";
export { PubRoom } from "./server/pub-room";
export { ZoneRoom } from "./server/zone-room";

const app = new Hono<AppEnv>();

// Open to anyone: signing in, and the build a tab should be running.
signInRoutes(app);
versionRoutes(app);

// Everything from here on answers only to a signed-in player.
signedInOnly(app);

meRoutes(app);
// Brings its own check: only on a development deployment.
devRoutes(app);
// Brings its own check for /api/admin: admins only.
contentRoutes(app);
characterRoutes(app);
stallRoutes(app);
hutRoutes(app);
pubRoutes(app);
releaseRoutes(app);
gatherRoutes(app);
fishRoutes(app);
projectRoutes(app);
keeperRoutes(app);
tradeRoutes(app);
crewRoutes(app);
atlasRoutes(app);
lapidaryRoutes(app);
chestRoutes(app);
zoneRoutes(app);

export default app;
