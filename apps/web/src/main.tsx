import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "react-hot-toast";
import "rpg-awesome/css/rpg-awesome.min.css";
import "./index.css";

import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
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
