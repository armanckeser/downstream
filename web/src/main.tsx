import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import "./index.css";
import { ReviewProvider } from "./lib/review.tsx";
import { useRoute } from "./lib/route.ts";
import { HoverProvider } from "./components/hover.tsx";
import { Home } from "./pages/home.tsx";
import { Review } from "./pages/review.tsx";
import { Session } from "./pages/session.tsx";

function App() {
  const route = useRoute();
  switch (route.page) {
    case "home":
      return <Home />;
    case "session":
      return <Session sessionKey={route.key} />;
    case "review":
      return (
        // Keyed so moving between reviews starts from a clean slate.
        <ReviewProvider key={`${route.repo}:${route.review ?? ""}`} repo={route.repo} review={route.review}>
          <HoverProvider>
            <Review />
          </HoverProvider>
        </ReviewProvider>
      );
  }
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
