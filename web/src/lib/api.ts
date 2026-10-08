// The browser calls the same actions as the agent's CLI.
import type { Presence, ReviewEvent, ReviewState } from "@domain/model.ts";

export class ApiError extends Error {}

export async function action<T = unknown>(name: string, input: unknown = {}): Promise<T> {
  const r = await fetch(`/api/actions/${name}`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-downstream-actor": "user" },
    body: JSON.stringify({ input }),
  });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(body.error ?? `${name} failed (${r.status})`);
  return body;
}

export async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, { signal });
  const body = (await r.json().catch(() => ({}))) as T & { error?: string };
  if (!r.ok) throw new ApiError(body?.error ?? `${path} failed (${r.status})`);
  return body;
}

export const fetchState = () => get<ReviewState>("/api/state");

export type Frame = { symbolId: string; file: string; patch: string; added: number; deleted: number };
export type Hover = { display: string; docs: string; tags: { name: string; text: string }[]; kind: string } | null;
export type Definition = { file: string; line: number; symbolId: string | null } | null;

const frameCache = new Map<string, Promise<Frame>>();
export function fetchFrame(symbolId: string, version: number): Promise<Frame> {
  const key = `${version}:${symbolId}`;
  let p = frameCache.get(key);
  if (!p) {
    p = get<Frame>(`/api/frame?symbol=${encodeURIComponent(symbolId)}`);
    p.catch(() => frameCache.delete(key));
    frameCache.set(key, p);
  }
  return p;
}

const q = (o: Record<string, string | number>) => new URLSearchParams(Object.entries(o).map(([k, v]) => [k, String(v)])).toString();

export const fetchHover = (file: string, line: number, col: number, side: "new" | "old", signal?: AbortSignal) =>
  get<Hover>(`/api/hover?${q({ file, line, col, side })}`, signal);

export const fetchDefinition = (file: string, line: number, col: number, side: "new" | "old") =>
  get<Definition>(`/api/definition?${q({ file, line, col, side })}`);

export function subscribe(handlers: { change: (e: ReviewEvent) => void; presence: (p: Presence) => void; status: (live: boolean) => void }) {
  let es: EventSource | null = null;
  let closed = false;
  let retry: ReturnType<typeof setTimeout>;
  const connect = () => {
    es = new EventSource("/api/events");
    es.addEventListener("open", () => handlers.status(true));
    es.addEventListener("change", (m) => handlers.change(JSON.parse((m as MessageEvent).data)));
    es.addEventListener("presence", (m) => handlers.presence(JSON.parse((m as MessageEvent).data)));
    es.addEventListener("error", () => {
      handlers.status(false);
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
