# Local-dev battlefield art

Drop a PNG here named `<scene>.png` and `vite dev` will serve it at
`/dev-battlefield/<scene>.png`. The hex-combat canvas probes that URL
first (only in `import.meta.env.DEV`) and uses it as the battlefield
background, bypassing the Flux/R2 cache for that one scene.

Valid scene keys (matches `BATTLEFIELD_PROMPTS` in `apps/web/src/ai.ts`):

- `server_catacomb`
- `cubicle_forest`
- `warehouse_floor`
- `fluorescent_office`
- `neon_basement`
- `deadline_dungeon`

Files in this directory are gitignored so a contributor's local art
stash doesn't get committed. Promote a curated PNG to production by
uploading to R2 — see [`docs/curated-battlefield-art.md`](../../../../docs/curated-battlefield-art.md).
