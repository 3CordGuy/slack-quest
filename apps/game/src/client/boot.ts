// The opening screen (index.html's #boot) is up from the page's first paint, moved by the browser itself so it
// goes on swinging while the game is busy loading. It is taken away here, once there is something to show in
// its place: the first view of the game, or a screen with no view to wait for.

let going = false;

/** Fade the opening screen out and take it away. Nothing happens after the first call. */
export function dismissBoot() {
  if (going) return;
  going = true;
  const el = document.getElementById("boot");
  if (!el) return;
  el.style.transition = "opacity 280ms ease-out";
  el.style.opacity = "0";
  el.style.pointerEvents = "none";
  setTimeout(() => el.remove(), 340);
}

// Never left up: whatever has gone wrong, the page under it is shown after a while.
setTimeout(dismissBoot, 60_000);
