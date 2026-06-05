// Pure game logic shared between the Slack worker and the web app.
// No D1, no HTTP, no Slack/React. Importable from any environment.

export * from "./combat";
export * from "./flavor";
export * from "./combat_machine";
export * from "./hex";
export * from "./abilities";
export * from "./abilities/types";
export * from "./abilities/tree";
export { newNodesForClass, ALL_NEW_NODES, NEW_ABILITY_DEFS } from "./abilities/new_nodes";
export * from "./achievements";
export * from "./stats";
export * from "./expedition";
export * from "./expedition-events";
