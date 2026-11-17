import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { CrashScreen } from "./Crash";
import { NewVersionNotice } from "./NewVersion";
import "./styles.css";
import "./theme.css";
import { installFrames } from "./ui/frames";

installFrames();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <CrashScreen>
      <App />
    </CrashScreen>
    <NewVersionNotice />
  </StrictMode>,
);
