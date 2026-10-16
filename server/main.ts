// The Downstream server: one per machine. The home page lives at `/`; each
// repository's reviews at `/r/<repo>/`, each with its own database in the repo.
import { Hono, type Context } from "hono";
import { streamSSE } from "hono/streaming";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { writeFileSync, rmSync, existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { Author, ReviewEvent } from "../domain/model.ts";
import { actions, ActionError } from "./actions.ts";
import { HomeStore, downstreamHome } from "./home-store.ts";
import { RepoRegistry, type RepoContext } from "./repos.ts";
import { AgentHost } from "./agent-host.ts";
import { homeRoutes } from "./home.ts";
import { packageRoot } from "./install.ts";

const args = Object.fromEntries(
  process.argv
    .slice(2)
    .map((a) => a.match(/^--([^=]+)=(.*)$/))
    .filter((m): m is RegExpMatchArray => !!m)
    .map((m) => [m[1], m[2]]),
);
const port = Number(args.port ?? 4317);
const dir = downstreamHome();
const home = new HomeStore();
const repos = new RepoRegistry(home);
const agents = new AgentHost();

const actorOf = (h: string | undefined): Author => (h === "agent" ? "agent" : "user");

type Env = { Variables: { repo: RepoContext } };

const app = new Hono();

app.onError((err, c) => {
  if (err instanceof ActionError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof z.ZodError) return c.json({ error: "Invalid input", issues: err.issues }, 400);
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : String(err) }, 500);
});

const startedAt = Date.now();
app.get("/api/health", (c) => c.json({ ok: true, pid: process.pid, startedAt, home: dir }));

/** The CLI registers the repository it runs in and gets back the id its reviews live under. */
app.post("/api/repos", async (c) => {
  const { root } = z.object({ root: z.string() }).parse(await c.req.json());
  if (!existsSync(root)) throw new ActionError(`No such directory: ${root}`);
  const repo = repos.register(root);
  return c.json({ id: repo.id, root: repo.root, nameWithOwner: repo.nameWithOwner });
});

app.route("/api", homeRoutes({ home, repos, agents }));

// --- one repository's reviews ---------------------------------------------------

const review = new Hono<Env>();

review.use(async (c, next) => {
  const repo = repos.get(c.req.param("repo") ?? "");
  if (!repo) return c.json({ error: "Unknown repository. Run `downstream open` inside it." }, 404);
  c.set("repo", repo);
  await next();
});

const reviewOf = (c: Context<Env>, q: string | undefined) => q || c.var.repo.store.currentReviewId();

review.get("/reviews", (c) => c.json({ current: c.var.repo.store.currentReviewId(), reviews: c.var.repo.store.listReviews() }));

review.get("/state", (c) => {
  const id = reviewOf(c, c.req.query("review"));
  if (!id) return c.json({ error: "No review yet. Run `downstream open`." }, 404);
  const state = c.var.repo.store.state(id);
  return state ? c.json(state) : c.json({ error: `No review ${id}` }, 404);
});

review.get("/actions", (c) =>
  c.json(
    [...actions.values()].map((a) => ({ name: a.name, description: a.description, readOnly: !!a.readOnly, input: z.toJSONSchema(a.input, { io: "input", unrepresentable: "any" }) })),
  ),
);

review.post("/actions/:name", async (c) => {
  const def = actions.get(c.req.param("name"));
  if (!def) return c.json({ error: `Unknown action ${c.req.param("name")}. GET /api/actions lists them.` }, 404);
  const body = (await c.req.json().catch(() => ({}))) as { review?: string; input?: unknown };
  const actor = actorOf(c.req.header("x-downstream-actor"));
  const repo = c.var.repo;
  const reviewId = def.name === "review.open" ? "" : reviewOf(c, body.review);
  if (def.name !== "review.open" && !reviewId) throw new ActionError("No review yet. Run `downstream open` first.", 404);
  if (actor === "agent") repo.store.touchAgent();
  const result = await def.run(repos.actionContext(repo, actor, reviewId ?? ""), def.input.parse(body.input ?? {}));
  return c.json(result ?? { ok: true });
});

review.get("/frame", (c) => {
  const id = reviewOf(c, c.req.query("review"))!;
  const symbol = c.var.repo.store.symbol(id, c.req.query("symbol") ?? "");
  if (!symbol) return c.json({ error: "No such symbol" }, 404);
  const frame = c.var.repo.workspace(id).frame(symbol);
  return frame ? c.json(frame) : c.json({ error: `Can't read ${symbol.file}` }, 404);
});

review.get("/file", (c) => {
  const id = reviewOf(c, c.req.query("review"))!;
  const side = c.req.query("side") === "old" ? "old" : "new";
  const text = c.var.repo.workspace(id).read(c.req.query("path") ?? "", side);
  return text === null ? c.json({ error: "Not found" }, 404) : c.json({ text });
});

const pos = (c: Context<Env>) => ({
  file: c.req.query("file") ?? "",
  line: Number(c.req.query("line")),
  col: Number(c.req.query("col")),
  side: (c.req.query("side") === "old" ? "old" : "new") as "new" | "old",
});

review.get("/hover", (c) => {
  const id = reviewOf(c, c.req.query("review"))!;
  const p = pos(c);
  return c.json(c.var.repo.workspace(id).hover(p.file, p.line, p.col, p.side));
});

review.get("/definition", (c) => {
  const id = reviewOf(c, c.req.query("review"))!;
  const p = pos(c);
  return c.json(c.var.repo.workspace(id).definition(p.file, p.line, p.col, p.side, c.var.repo.store.symbols(id)));
});

review.get("/symbol-at", (c) => {
  const id = reviewOf(c, c.req.query("review"))!;
  return c.json(c.var.repo.workspace(id).symbolAt(c.req.query("file") ?? "", Number(c.req.query("line"))));
});

/** Live sync for the browser: every event, plus presence changes. */
review.get("/events", (c) => {
  const id = reviewOf(c, c.req.query("review"));
  const { store } = c.var.repo;
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
const LISTEN_TO = new Set(["note.added", "note.replied", "note.status", "note.updated", "ask", "review.verdict", "review.done", "review.published", "post.drafted", "post.updated", "post.discarded", "post.sent", "symbol.annotated", "symbol.added", "edge.added", "steps.set"]);
review.get("/wait", async (c) => {
  const { store } = c.var.repo;
  const id = reviewOf(c, c.req.query("review"));
  if (!id) return c.json({ error: "No review" }, 404);
  const after = Number(c.req.query("after") ?? store.cursor(id));
  const timeout = Math.min(Number(c.req.query("timeout") ?? 600), 3600) * 1000;
  const pending = () => store.events(id, after, "user").filter((e) => LISTEN_TO.has(e.type));
  const ready = pending();
  if (ready.length) {
    store.markRead(id, ready);
    return c.json({ events: ready, cursor: store.cursor(id), timedOut: false });
  }

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
    store.markRead(id, events);
    return c.json({ events, cursor: store.cursor(id), timedOut: events.length === 0 });
  } finally {
    store.waiterLeft();
  }
});

app.route("/r/:repo/api", review);

const dist = path.join(packageRoot, "web", "dist");
if (existsSync(dist)) {
  const rel = path.relative(process.cwd(), dist) || ".";
  app.use("/*", serveStatic({ root: rel }));
  // Read per request: a rebuilt UI points at new asset hashes, and a cached copy would load the old bundle.
  app.get("*", (c) => c.html(readFileSync(path.join(dist, "index.html"), "utf8")));
} else {
  app.get("/", (c) => c.text("The web UI isn't built. Run `npm run build` in the downstream skill directory."));
}

const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
  const url = `http://127.0.0.1:${info.port}`;
  writeFileSync(path.join(dir, "server.json"), JSON.stringify({ url, port: info.port, pid: process.pid }, null, 2));
  console.log(`downstream listening on ${url}`);
});

const shutdown = () => {
  try {
    agents.stopAll();
    rmSync(path.join(dir, "server.json"), { force: true });
  } finally {
    server.close();
    process.exit(0);
  }
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
