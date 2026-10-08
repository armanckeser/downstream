// The local Downstream server: one per repository, started by `downstream open`.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { Author, ReviewEvent } from "../domain/model.ts";
import { actions, ActionError, type ActionContext } from "./actions.ts";
import { Store } from "./store.ts";
import { Workspace } from "./workspace.ts";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.match(/^--([^=]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], m[2]]),
);
const root = path.resolve(args.root ?? process.cwd());
const port = Number(args.port ?? 4317);
const dir = path.join(root, ".downstream");
mkdirSync(dir, { recursive: true });
const store = new Store(path.join(dir, "review.db"));

const workspaces = new Map<string, Workspace>();
const workspace = (reviewId: string) => {
  let ws = workspaces.get(reviewId);
  if (!ws) {
    const review = store.review(reviewId);
    if (!review) throw new ActionError(`No review ${reviewId}`, 404);
    ws = new Workspace(store.reviewRoot(reviewId) || root, review);
    workspaces.set(reviewId, ws);
  }
  return ws;
};

const actorOf = (h: string | undefined): Author => (h === "agent" ? "agent" : "user");
const reviewOf = (q: string | undefined) => q || store.currentReviewId();

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof ActionError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof z.ZodError) return c.json({ error: "Invalid input", issues: err.issues }, 400);
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

app.get("/api/health", (c) => c.json({ ok: true, root, pid: process.pid }));

app.get("/api/reviews", (c) => c.json({ current: store.currentReviewId(), reviews: store.listReviews() }));

app.get("/api/state", (c) => {
  const id = reviewOf(c.req.query("review"));
  if (!id) return c.json({ error: "No review yet. Run `downstream open`." }, 404);
  const state = store.state(id);
  return state ? c.json(state) : c.json({ error: `No review ${id}` }, 404);
});

app.get("/api/actions", (c) =>
  c.json(
    [...actions.values()].map((a) => ({ name: a.name, description: a.description, readOnly: !!a.readOnly, input: z.toJSONSchema(a.input, { io: "input", unrepresentable: "any" }) })),
  ),
);

app.post("/api/actions/:name", async (c) => {
  const def = actions.get(c.req.param("name"));
  if (!def) return c.json({ error: `Unknown action ${c.req.param("name")}. GET /api/actions lists them.` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { review?: string; input?: unknown };
  const actor = actorOf(c.req.header("x-downstream-actor"));
  const reviewId = def.name === "review.open" ? "" : reviewOf(body.review);
  if (def.name !== "review.open" && !reviewId) throw new ActionError("No review yet. Run `downstream open` first.", 404);
  if (actor === "agent") store.touchAgent();
  const ctx: ActionContext & { reviewId: string } = {
    store,
    actor,
    root,
    workspace,
    dropWorkspace: (id) => workspaces.delete(id),
    reviewId: reviewId ?? "",
  };
  const result = await def.run(ctx, def.input.parse(body.input ?? {}));
  return c.json(result ?? { ok: true });
});

app.get("/api/frame", (c) => {
  const id = reviewOf(c.req.query("review"))!;
  const symbol = store.symbol(id, c.req.query("symbol") ?? "");
  if (!symbol) return c.json({ error: "No such symbol" }, 404);
  const frame = workspace(id).frame(symbol);
  return frame ? c.json(frame) : c.json({ error: `Can't read ${symbol.file}` }, 404);
});

app.get("/api/file", (c) => {
  const id = reviewOf(c.req.query("review"))!;
  const side = c.req.query("side") === "old" ? "old" : "new";
  const text = workspace(id).read(c.req.query("path") ?? "", side);
  return text === null ? c.json({ error: "Not found" }, 404) : c.json({ text });
});

const pos = (c: { req: { query: (k: string) => string | undefined } }) => ({
  file: c.req.query("file") ?? "",
  line: Number(c.req.query("line")),
  col: Number(c.req.query("col")),
  side: (c.req.query("side") === "old" ? "old" : "new") as "new" | "old",
});

app.get("/api/hover", (c) => {
  const id = reviewOf(c.req.query("review"))!;
  const p = pos(c);
  return c.json(workspace(id).hover(p.file, p.line, p.col, p.side));
});

app.get("/api/definition", (c) => {
  const id = reviewOf(c.req.query("review"))!;
  const p = pos(c);
  return c.json(workspace(id).definition(p.file, p.line, p.col, p.side, store.symbols(id)));
});

app.get("/api/symbol-at", (c) => {
  const id = reviewOf(c.req.query("review"))!;
  return c.json(workspace(id).symbolAt(c.req.query("file") ?? "", Number(c.req.query("line"))));
});

/** Live sync for the browser: every event, plus presence changes. */
app.get("/api/events", (c) => {
  const id = reviewOf(c.req.query("review"));
  return streamSSE(c, async (stream) => {
    let open = true;
    const onEvent = (reviewId: string, e: ReviewEvent) => {
      if (open && reviewId === id) void stream.writeSSE({ event: "change", data: JSON.stringify(e), id: String(e.id) });
    };
    const onPresence = () => {
      if (open) void stream.writeSSE({ event: "presence", data: JSON.stringify(store.presence()) });
    };
    store.bus.on("event", onEvent);
    store.bus.on("presence", onPresence);
    onPresence();
    stream.onAbort(() => {
      open = false;
      store.bus.off("event", onEvent);
      store.bus.off("presence", onPresence);
    });
    while (open) {
      await stream.sleep(20_000);
      if (open) onPresence();
    }
  });
});

/**
 * The agent's ear. Blocks until the user does something (replies, asks,
 * resolves, gives a verdict, ends the session) and returns those events.
 * While it blocks, the UI shows the agent as listening.
 */
const LISTEN_TO = new Set(["note.added", "note.replied", "note.status", "ask", "review.verdict", "review.done", "symbol.annotated", "symbol.added", "edge.added", "steps.set"]);
app.get("/api/wait", async (c) => {
  const id = reviewOf(c.req.query("review"));
  if (!id) return c.json({ error: "No review" }, 404);
  const after = Number(c.req.query("after") ?? store.cursor(id));
  const timeout = Math.min(Number(c.req.query("timeout") ?? 600), 3600) * 1000;
  const pending = () => store.events(id, after, "user").filter((e) => LISTEN_TO.has(e.type));
  const ready = pending();
  if (ready.length) return c.json({ events: ready, cursor: store.cursor(id), timedOut: false });

  store.waiterJoined();
  try {
    const events = await new Promise<ReviewEvent[]>((resolve) => {
      let timer: NodeJS.Timeout;
      const onEvent = (reviewId: string, e: ReviewEvent) => {
        if (reviewId !== id || e.actor !== "user" || !LISTEN_TO.has(e.type)) return;
        // Let a burst (e.g. reply + resolve) land together.
        setTimeout(() => finish(pending()), 400);
      };
      const finish = (evs: ReviewEvent[]) => {
        clearTimeout(timer);
        store.bus.off("event", onEvent);
        c.req.raw.signal.removeEventListener("abort", onAbort);
        resolve(evs);
      };
      const onAbort = () => finish([]);
      timer = setTimeout(() => finish([]), timeout);
      store.bus.on("event", onEvent);
      c.req.raw.signal.addEventListener("abort", onAbort);
    });
    return c.json({ events, cursor: store.cursor(id), timedOut: events.length === 0 });
  } finally {
    store.waiterLeft();
  }
});

const dist = path.join(here, "..", "web", "dist");
if (existsSync(dist)) {
  const rel = path.relative(process.cwd(), dist) || ".";
  app.use("/*", serveStatic({ root: rel }));
  const index = readFileSync(path.join(dist, "index.html"), "utf8");
  app.get("*", (c) => c.html(index));
} else {
  app.get("/", (c) => c.text("The web UI isn't built. Run `npm run build` in the downstream skill directory."));
}

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  const url = `http://127.0.0.1:${info.port}`;
  writeFileSync(path.join(dir, "server.json"), JSON.stringify({ url, port: info.port, pid: process.pid, root }, null, 2));
  console.log(`downstream listening on ${url}`);
});

const shutdown = () => {
  try {
    rmSync(path.join(dir, "server.json"), { force: true });
  } finally {
    server.close();
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
