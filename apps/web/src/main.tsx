import React, { useEffect } from "react";
import ReactDOM from "react-dom/client";
import { Toaster, toast } from "react-hot-toast";
import "rpg-awesome/css/rpg-awesome.min.css";
import "./index.css";

import { App } from "./App";

// Dismisses every visible toast on any tap/click on the page. Without this,
// mobile users frequently get stuck with a toast lingering after they've
// already read it (the auto-timeout is long enough to feel sticky and there's
// no swipe-to-dismiss on tap). Runs on pointerdown so the dismiss happens
// before the click handler fires — any toast queued by that same handler
// (e.g. an "out of range" rejection) gets posted after dismiss runs and so
// remains visible.
function DismissToastsOnTap() {
  useEffect(() => {
    const onPointerDown = () => toast.dismiss();
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
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
        },
        error: { iconTheme: { primary: "#fca5a5", secondary: "#1a1c20" } },
        success: { duration: 3000, iconTheme: { primary: "#86efac", secondary: "#1a1c20" } },
      }}
    />
  </React.StrictMode>,
);
