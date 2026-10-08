import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ReviewProvider } from "./lib/review.tsx";
import { HoverProvider } from "./components/hover.tsx";
import { App } from "./App.tsx";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ReviewProvider>
      <HoverProvider>
        <App />
      </HoverProvider>
    </ReviewProvider>
  </StrictMode>,
);
