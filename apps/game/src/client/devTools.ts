// Whether this is a development deployment: the worker's ENVIRONMENT var is
// "dev" (local and staging; production leaves it out). /api/me says so, and
// loadMe() records it here before anything is drawn, so code with no `me` to
// hand (the renderer's sky) can ask too.
//
// It switches on the toolbox in the top-right corner (DevToolbox.tsx): a
// held time of day and weather and the audio engine's readout, which act on
// your own tab, and seeding gold and items for your own hero, which the
// server allows only on such a deployment (server/dev.ts).

let on = false;

export const devTools = {
  get on() {
    return on;
  },
  set(value: boolean) {
    on = value;
    // The stylesheet makes room in the corner for the toolbox's button.
    document.documentElement.classList.toggle("dev-tools", value);
  },
};
