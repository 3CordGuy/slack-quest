import React from "react";
import ReactDOM from "react-dom/client";
import { Toaster } from "react-hot-toast";
import "rpg-awesome/css/rpg-awesome.min.css";

import { App } from "./App";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <App />
    <Toaster
      position="top-center"
      toastOptions={{
        style: {
          background: "#1a1c20",
          color: "#f5f5f5",
          border: "1px solid #2a2d33",
          fontSize: 14,
        },
        error: { iconTheme: { primary: "#fca5a5", secondary: "#1a1c20" } },
        success: { iconTheme: { primary: "#86efac", secondary: "#1a1c20" } },
      }}
    />
  </React.StrictMode>,
);
