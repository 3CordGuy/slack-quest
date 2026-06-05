import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { Toaster, ToastBar, toast } from "react-hot-toast";
import "rpg-awesome/css/rpg-awesome.min.css";
import "./index.css";

import { App } from "./App";

// Dismiss-on-tap, two layers deep so it's actually reliable on mobile:
//
//   1. A document touchstart/mousedown listener (capture phase) dismisses
//      every visible toast when the user taps ANYWHERE — including the toast
//      itself. Capture phase + touchstart (not pointerdown) fires earliest
//      across iOS Safari, Chrome, and Firefox.
//   2. Each rendered toast is wrapped in an onClick handler that dismisses
//      it specifically. Belt-and-suspenders: if the toast's positioning ever
//      intercepts touch events such that the global listener misses them
//      (e.g. an iOS quirk inside the react-hot-toast portal), the local
//      click still works.
//
// Either layer is enough on its own; together a stuck toast should be hard
// to reach.
function DismissToastsOnTap() {
  useEffect(() => {
    const dismiss = () => toast.dismiss();
    // capture: true so we fire before any stopPropagation in the app, and
    // before React's synthetic-event delegation runs.
    const opts = { capture: true, passive: true } as const;
    window.addEventListener("touchstart", dismiss, opts);
    window.addEventListener("mousedown", dismiss, opts);
    return () => {
      window.removeEventListener("touchstart", dismiss, opts);
      window.removeEventListener("mousedown", dismiss, opts);
    };
  }, []);
  return null;
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <DismissToastsOnTap />
    <Toaster
      position="top-center"
      toastOptions={{
        style: {
          background: "var(--bg-input)",
          color: "var(--fg-1)",
          border: "1px solid var(--border-base)",
          fontSize: 14,
          fontFamily: "var(--font-body)",
          boxShadow: "var(--shadow-pop)",
          cursor: "pointer",
        },
        error: { iconTheme: { primary: "#fca5a5", secondary: "#1a1c20" } },
        success: { duration: 3000, iconTheme: { primary: "#86efac", secondary: "#1a1c20" } },
      }}
    >
      {(t) => (
        <div onClick={() => toast.dismiss(t.id)} style={{ cursor: "pointer" }}>
          <ToastBar toast={t} />
        </div>
      )}
    </Toaster>
  </React.StrictMode>,
);
