// The browser calls the same actions as the agent's CLI. Review calls go to the
// open repository's API (`/r/<repo>/api`); home and agent calls to `/api`.
import type { Presence, ReviewEvent, ReviewState } from "@domain/model.ts";
import type { HomeView } from "@domain/home.ts";
import type { AgentView } from "@domain/agent.ts";
import type { PrDetail } from "@domain/pr-detail.ts";

export class ApiError extends Error {}

let repoApi = "/api";
let reviewId: string | null = null;

/** Point review calls at a repository (and optionally one of its reviews). Clears per-review caches. */
export function setRepo(repo: string, review: string | null) {
  const next = `/r/${encodeURIComponent(repo)}/api`;
  if (next !== repoApi || review !== reviewId) frameCache.clear();
  repoApi = next;
  reviewId = review;
}

const withReview = (path: string) => (reviewId ? `${path}${path.includes("?") ? "&" : "?"}review=${encodeURIComponent(reviewId)}` : path);

async function post<T>(url: string, body: unknown): Promise<T> {
  const r = await fetch(url, { method: "POST", headers: { "content-type": "application/json", "x-downstream-actor": "user" }, body: JSON.stringify(body) });
  const json = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(json.error ?? `${url} failed (${r.status})`);
  return json;
}

export async function action<T = unknown>(name: string, input: unknown = {}): Promise<T> {
  return post<T>(`${repoApi}/actions/${name}`, { input, ...(reviewId ? { review: reviewId } : {}) });
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, { signal });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(body?.error ?? `${path} failed (${r.status})`);
  return body;
}

export const fetchState = () => get<ReviewState>(withReview(`${repoApi}/state`));

export type Frame = { symbolId: string; file: string; patch: string; added: number; deleted: number };
export type Hover = { display: string; docs: string; tags: { name: string; text: string }[]; kind: string } | null;
export type Definition = { file: string; line: number; symbolId: string | null } | null;

const frameCache = new Map<string, Promise<Frame>>();
export function fetchFrame(symbolId: string, version: number): Promise<Frame> {
  const key = `${version}:${symbolId}`;
  let p = frameCache.get(key);
  if (!p) {
    p = get<Frame>(withReview(`${repoApi}/frame?symbol=${encodeURIComponent(symbolId)}`));
    p.catch(() => frameCache.delete(key));
    frameCache.set(key, p);
  }
  return p;
}

const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export const fetchHover = (file: string, line: number, col: number, side: "new" | "old", signal?: AbortSignal) =>
  get<Hover>(withReview(`${repoApi}/hover?${q({ file, line, col, side })}`), signal);

export const fetchDefinition = (file: string, line: number, col: number, side: "new" | "old") =>
  get<Definition>(withReview(`${repoApi}/definition?${q({ file, line, col, side })}`));

/** An EventSource that reconnects, reporting whether it's live. */
function stream(url: string, events: Record<string, (data: string) => void>, status: (live: boolean) => void) {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout>;
  const connect = () => {
    es = new EventSource(url);
    es.addEventListener("open", () => status(true));
    for (const [name, handler] of Object.entries(events)) es.addEventListener(name, (m) => handler((m as MessageEvent).data));
    es.addEventListener("error", () => {
      status(false);
      es?.close();
      if (!closed) retry = setTimeout(connect, 1500);
    });
  };
  connect();
  return () => {
    closed = true;
    clearTimeout(retry);
    es?.close();
  };
}

export function subscribe(handlers: { change: (e: ReviewEvent) => void; presence: (p: Presence) => void; status: (live: boolean) => void }) {
  return stream(
    withReview(`${repoApi}/events`),
    { change: (d) => handlers.change(JSON.parse(d)), presence: (d) => handlers.presence(JSON.parse(d)) },
    handlers.status,
  );
}

// --- home and agent sessions -------------------------------------------------------

export const fetchHome = () => get<HomeView>("/api/home");
export const fetchPrDetail = (repo: string, number: number) => get<PrDetail>(`/api/prs/${repo}/${number}`);
export const fetchAgent = (key: string) => get<AgentView>(`/api/agents/${encodeURIComponent(key)}`);
export const homeAction = <T = { ok: true }>(name: string, input: unknown = {}) => post<T>(`/api/home/actions/${name}`, { input });

type HomeHandlers = { home: () => void; agent: (v: AgentView) => void; status?: (live: boolean) => void };
const homeListeners = new Set<HomeHandlers>();
let closeHome: (() => void) | null = null;

/** One shared connection for every subscriber on the page: browsers allow only a few per host. */
export function subscribeHome(handlers: HomeHandlers) {
  homeListeners.add(handlers);
  closeHome ??= stream(
    "/api/events",
    {
      home: () => homeListeners.forEach((h) => h.home()),
      agent: (d) => {
        const v = JSON.parse(d) as AgentView;
        homeListeners.forEach((h) => h.agent(v));
      },
    },
    (live) => homeListeners.forEach((h) => h.status?.(live)),
  );
  return () => {
    homeListeners.delete(handlers);
    if (homeListeners.size === 0) {
      closeHome?.();
      closeHome = null;
    }
  };
}
