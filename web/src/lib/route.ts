// Three places to be: home, a review, an agent session. Paths, not hashes, so a
// review's address is the one the CLI prints.
import { useEffect, useState } from "react";

export type Route =
  | { page: "home" }
  | { page: "review"; repo: string; review: string | null }
  | { page: "session"; key: string };

export function parse(location: { pathname: string; search: string }): Route {
  const review = location.pathname.match(/^\/r\/([^/]+)\/?$/);
  if (review) return { page: "review", repo: decodeURIComponent(review[1]!), review: new URLSearchParams(location.search).get("review") };
  const session = location.pathname.match(/^\/s\/([^/]+)\/?$/);
  if (session) return { page: "session", key: decodeURIComponent(session[1]!) };
  return { page: "home" };
}

const listeners = new Set<() => void>();

export function navigate(path: string) {
  if (path === location.pathname + location.search) return;
  history.pushState(null, "", path);
  for (const l of listeners) l();
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(location));
  useEffect(() => {
    const update = () => setRoute(parse(location));
    listeners.add(update);
    window.addEventListener("popstate", update);
    return () => {
      listeners.delete(update);
      window.removeEventListener("popstate", update);
    };
  }, []);
  return route;
}
