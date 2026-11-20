// Dev server only: where the time went while the game opened.
//
// Each view notes when its place was built, when its shaders were compiled and
// when it was first drawn. When the first view is shown, one line is written
// to the console: those notes, and every stretch of 200 ms or more in which
// the page could do nothing else. It is for finding out why a load is slow on
// one browser and not another; it does nothing in a production build.

const on = import.meta.env.DEV;
const notes: [string, number, number?][] = [];
const stalls: [number, number][] = [];
let told = false;

if (on && typeof PerformanceObserver === "function") {
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) if (e.duration >= 200) stalls.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: "longtask", buffered: true });
  } catch {
    // A browser that does not report long tasks: the notes alone are written.
  }
}

/** Note that something happened now (ms since the page began to load), and how long it took if that is known. */
export function loadNote(what: string, took?: number) {
  if (!on || told) return;
  notes.push(took === undefined ? [what, Math.round(performance.now())] : [what, Math.round(performance.now()), Math.round(took)]);
}

/** The first view is on the screen: write the line. */
export function loadShown(what: string) {
  if (!on || told) return;
  loadNote(`shown ${what}`);
  told = true;
  const gl = document.createElement("canvas").getContext("webgl2");
  const info = gl?.getExtension("WEBGL_debug_renderer_info");
  console.info(
    "GQ LOAD " +
      JSON.stringify({
        notes,
        stalls,
        gpu: info ? gl!.getParameter(info.UNMASKED_RENDERER_WEBGL) : null,
        parallel: !!gl?.getExtension("KHR_parallel_shader_compile"),
        window: [innerWidth, innerHeight, devicePixelRatio],
        visible: document.visibilityState,
        fancy: localStorage.getItem("gq.graphics.fancy"),
      }),
  );
}
