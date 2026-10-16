// The home page's server side: the inbox for the account you're looking
// through (cached, refreshed in the background), sorted into the matrix with
// your choices applied, and starting the agent on a pull request.
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { arrange, moveFor, MOVES, Quadrant, toItems, withTouches, type Item, type Move, type PrFacts, type Touch } from "../domain/inbox.ts";
import { prKey } from "../domain/agent.ts";
import { lastRound, type HomeView, type PrSession } from "../domain/home.ts";
import { nextMove } from "../domain/next-move.ts";
import { accounts } from "./gh.ts";
import { fetchAvatar, fetchDetail, fetchPrs, fetchTouches } from "./github.ts";
import type { PrDetail } from "../domain/pr-detail.ts";
import type { HomeStore } from "./home-store.ts";
import type { RepoContext, RepoRegistry } from "./repos.ts";
import type { ReviewEvent } from "../domain/model.ts";
import type { AgentHost } from "./agent-host.ts";
import { promptFor, stalePrompt } from "./prompts.ts";
import { decide, GitHubRefused, NotOffered, StaleDecision } from "./stale.ts";
import { ActionError, openReview } from "./actions.ts";

const STALE_AFTER_MS = 60_000;

type Snapshot = { prs: PrFacts[]; touches: Touch[]; at: string } | null;

/** One account's PRs, fetched at most once at a time, kept until the next fetch lands. */
class InboxCache {
  private snapshots = new Map<string, Snapshot>();
  private inflight = new Map<string, Promise<void>>();
  private errors = new Map<string, string>();

  private readonly onChange: () => void;

  constructor(onChange: () => void) {
    this.onChange = onChange;
  }

  get(account: string): Snapshot {
    return this.snapshots.get(account) ?? null;
  }

  error(account: string): string | null {
    return this.errors.get(account) ?? null;
  }

  refreshing(account: string): boolean {
    return this.inflight.has(account);
  }

  /** Fetch if never fetched or stale (or `force`); returns once the fetch is done. */
  refresh(account: string, force = false): Promise<void> {
    const snap = this.get(account);
    const fresh = snap && Date.now() - Date.parse(snap.at) < STALE_AFTER_MS;
    if (fresh && !force) return Promise.resolve();
    const running = this.inflight.get(account);
    if (running) return running;
    // Without the activity feed the inbox still works, just without knowing your focus.
    const p = Promise.all([fetchPrs(account), fetchTouches(account).catch(() => [])])
      .then(([prs, touches]) => {
        this.snapshots.set(account, { prs: withTouches(prs, touches), touches, at: new Date().toISOString() });
        this.errors.delete(account);
      })
      .catch((e: Error) => {
        this.errors.set(account, e.message.split("\n").slice(0, 2).join(" "));
      })
      .finally(() => {
        this.inflight.delete(account);
        this.onChange();
      });
    this.inflight.set(account, p);
    this.onChange();
    return p;
  }
}

export function homeRoutes(deps: { home: HomeStore; repos: RepoRegistry; agents: AgentHost }) {
  const { home, repos, agents } = deps;
  const app = new Hono();
  const cache = new InboxCache(() => home.changed());
  let known: string[] | null = null;
  const accountList = () => (known ??= accounts());
  const avatars = new Map<string, string | null>();
  const avatarOf = (login: string) => {
    if (!avatars.has(login)) {
      avatars.set(login, null);
      void fetchAvatar(login).then((url) => {
        avatars.set(login, url);
        if (url) home.changed();
      });
    }
    return avatars.get(login) ?? null;
  };
  const currentAccount = () => {
    const chosen = home.account();
    const list = accountList();
    return chosen && list.includes(chosen) ? chosen : (list[0] ?? null);
  };

  /** Rounds the agent was already started on, so pressing Re-review twice doesn't repeat the task. */
  const prompted = new Set<string>();

  const items = (account: string): Item[] => toItems(cache.get(account)?.prs ?? []);

  /** Each PR's own next move, by `prKey`, for the account you're looking through. */
  const movesOf = (account: string | null): Map<string, Move> =>
    new Map((account ? (cache.get(account)?.prs ?? []) : []).map((pr) => [prKey(pr.repo, pr.number), moveFor(pr)]));

  function sessions(account: string | null): Record<string, PrSession> {
    const moves = movesOf(account);
    const out: Record<string, PrSession> = {};
    const at = (key: string) => (out[key] ??= { agent: null, review: null });
    for (const v of agents.views()) {
      // What the agent said, never the commands it ran: those are its business, not yours.
      const said = [...v.activity].reverse().find((a) => a.kind === "text");
      const line = said?.kind === "text" ? said.text.split("\n")[0]!.slice(0, 140) : null;
      at(prKey(v.repo, v.pr)).agent = { status: v.status, line, approvals: v.approvals.length };
    }
    for (const repo of repos.withReviews()) {
      if (!repo.nameWithOwner) continue;
      const seen = new Set<number>();
      for (const review of repo.store.listReviews()) {
        if (review.pr === null || seen.has(review.pr)) continue;
        seen.add(review.pr);
        const state = repo.store.state(review.id);
        if (!state) continue;
        const key = prKey(repo.nameWithOwner, review.pr);
        const move = moves.get(key);
        if (move && lastRound(state.review.published, move)) continue;
        at(key).review = { path: `/r/${repo.id}?review=${review.id}`, title: review.title, move: nextMove(state, new Set(state.visited)) };
      }
    }
    return out;
  }

  function view(): HomeView {
    const account = currentAccount();
    const snap = account ? cache.get(account) : null;
    if (account) void cache.refresh(account);
    return {
      accounts: accountList().map((login) => ({ login, avatar: avatarOf(login) })),
      account,
      inbox: snap && account ? arrange(items(account), home.choices(account), new Date(), snap.touches) : null,
      fetchedAt: snap?.at ?? null,
      refreshing: account ? cache.refreshing(account) : false,
      error: account ? cache.error(account) : "gh isn't logged in to any GitHub account. Run `gh auth login`.",
      sessions: sessions(account),
    };
  }

  /** A PR in the stale sweep, or a 404 the browser shows as "refresh". */
  function staleItem(account: string, key: string): Item {
    const inbox = arrange(items(account), home.choices(account), new Date(), cache.get(account)?.touches ?? []);
    const item = inbox.stale.find((i) => i.key === key);
    if (!item) throw new ActionError("That pull request isn't stale any more. Refresh.", 404);
    return item;
  }

  /**
   * Start (or resume) the agent on an item. Returns where the browser should go.
   * `stale` asks for a recommendation instead of the item's move.
   */
  async function start(account: string, key: string, ask: "move" | "stale" = "move"): Promise<{ path: string } | { url: string }> {
    const item = ask === "stale" ? staleItem(account, key) : items(account).find((i) => i.key === key);
    if (!item) throw new ActionError("That pull request isn't in your inbox any more. Refresh.", 404);
    const pr = item.lead;
    const opens = MOVES[item.move.kind].opens;
    if (ask === "move" && opens === "github") return { url: pr.url };
    const agentKey = prKey(pr.repo, pr.number);
    const existing = sessions(account)[agentKey];
    const where = existing?.review ? { path: existing.review.path } : { path: `/s/${encodeURIComponent(agentKey)}` };
    // A new round: the agent from the last one is told what came back, once per hand-back.
    const round = ask === "move" && item.move.kind === "rereview" && !existing?.review ? `${agentKey}@${item.move.because.at}` : null;
    if (agents.live(agentKey)) {
      const prompt = round && !prompted.has(round) ? promptFor(item, false) : null;
      if (prompt) agents.send(agentKey, prompt);
      if (round) prompted.add(round);
      return where;
    }
    const root = repos.find(pr.repo) ?? (await repos.clone(pr.repo, account));
    const repo = repos.register(root);
    if (ask === "move" && !promptFor(item, false)) return { url: pr.url };
    if (round) prompted.add(round);
    const previous = home.launch(pr.repo, pr.number);
    home.putLaunch({ account, repo: pr.repo, pr: pr.number, root, sessionId: null });
    const resumeId = previous?.root === root ? previous.sessionId : null;
    if (resumeId && !round) {
      agents.start({ key: agentKey, repo: pr.repo, pr: pr.number, root, account, prompt: "I'm back. Pick up where we left off; run `downstream wait` if you're mid-review.", resumeId });
      return where;
    }
    const opened = ask === "move" && opens === "review" ? await openFirst(repo, pr.number) : null;
    const prompt = ask === "stale" ? stalePrompt(item) : promptFor(item, opened !== null)!;
    agents.start({ key: agentKey, repo: pr.repo, pr: pr.number, root, account, prompt, resumeId });
    return opened ?? where;
  }

  /**
   * The mechanical part of a review needs no agent: fetch, diff and the call
   * graph. Doing it here puts the change's shape on screen while the agent is
   * still starting. If it fails, the agent opens the review itself and says why.
   */
  async function openFirst(repo: RepoContext, pr: number): Promise<{ path: string } | null> {
    try {
      const { review } = await openReview.run(repos.actionContext(repo, "user", ""), openReview.input.parse({ pr }));
      return { path: `/r/${repo.id}?review=${review.id}` };
    } catch (e) {
      console.error(`Opening #${pr} before the agent failed; the agent will open it: ${(e as Error).message}`);
      return null;
    }
  }

  // The session id appears a moment after start; keep it so a later visit can resume.
  agents.bus.on("changed", (key: string) => {
    const v = agents.view(key);
    if (v?.sessionId) {
      const launch = home.launch(v.repo, v.pr);
      if (launch && launch.sessionId !== v.sessionId) home.putLaunch({ ...launch, sessionId: v.sessionId });
    }
    home.changed();
  });

  // A message you write in a review reaches an agent that went idle.
  const WAKES = new Set(["ask", "note.replied", "note.added", "review.verdict"]);
  repos.bus.on("event", (repo: RepoContext, reviewId: string, e: ReviewEvent) => {
    home.changed();
    if (e.actor !== "user" || !WAKES.has(e.type) || !repo.nameWithOwner) return;
    const pr = repo.store.review(reviewId)?.pr;
    if (pr != null) agents.nudge(prKey(repo.nameWithOwner, pr));
  });

  app.get("/home", async (c) => {
    const account = currentAccount();
    if (account && !cache.get(account)) await cache.refresh(account);
    return c.json(view());
  });

  // Details change with every push; a minute keeps j/k through the list instant without going stale.
  const details = new Map<string, { at: number; detail: Promise<PrDetail> }>();
  app.get("/prs/:owner/:name/:number", async (c) => {
    const account = currentAccount();
    if (!account) return c.json({ error: "No GitHub account." }, 400);
    const repo = `${c.req.param("owner")}/${c.req.param("name")}`;
    const number = Number(c.req.param("number"));
    const key = `${account}:${repo}#${number}`;
    let hit = details.get(key);
    if (!hit || Date.now() - hit.at > STALE_AFTER_MS) {
      hit = { at: Date.now(), detail: fetchDetail(account, repo, number) };
      details.set(key, hit);
      hit.detail.catch(() => details.delete(key));
    }
    try {
      return c.json(await hit.detail);
    } catch (e) {
      return c.json({ error: (e as Error).message.split("\n")[0] }, 502);
    }
  });

  app.get("/agents/:key", (c) => {
    const v = agents.view(c.req.param("key"));
    return v ? c.json(v) : c.json({ error: "No agent session for this pull request." }, 404);
  });

  const HomeActions = {
    "home.account": z.object({ login: z.string() }),
    "home.choose": z.object({ key: z.string(), quadrant: Quadrant.nullable() }),
    "home.refresh": z.object({}),
    "home.start": z.object({ key: z.string() }),
    "stale.decide": z.object({ key: z.string(), decision: StaleDecision }),
    "stale.ask": z.object({ key: z.string() }),
    "agent.send": z.object({ key: z.string(), text: z.string().min(1) }),
    "agent.decide": z.object({ key: z.string(), approvalId: z.string(), allow: z.boolean() }),
    "agent.handoff": z.object({ key: z.string() }),
  } as const;

  app.post("/home/actions/:name", async (c) => {
    const name = c.req.param("name") as keyof typeof HomeActions;
    const schema = HomeActions[name];
    if (!schema) return c.json({ error: `Unknown action ${name}` }, 404);
    const input = schema.parse(((await c.req.json().catch(() => ({}))) as { input?: unknown }).input ?? {});
    const account = currentAccount();
    switch (name) {
      case "home.account": {
        const { login } = input as z.infer<(typeof HomeActions)["home.account"]>;
        if (!accountList().includes(login)) throw new ActionError(`gh isn't logged in as ${login}.`);
        home.setAccount(login);
        void cache.refresh(login);
        return c.json({ ok: true });
      }
      case "home.choose": {
        if (!account) throw new ActionError("No GitHub account.");
        const { key, quadrant } = input as z.infer<(typeof HomeActions)["home.choose"]>;
        home.choose(account, key, quadrant);
        return c.json({ ok: true });
      }
      case "home.refresh":
        if (account) await cache.refresh(account, true);
        return c.json({ ok: true });
      case "home.start": {
        if (!account) throw new ActionError("No GitHub account.");
        return c.json(await start(account, (input as { key: string }).key));
      }
      case "stale.decide": {
        if (!account) throw new ActionError("No GitHub account.");
        const { key, decision } = input as z.infer<(typeof HomeActions)["stale.decide"]>;
        try {
          await decide(account, staleItem(account, key), decision, () => home.choose(account, key, "hidden"));
        } catch (e) {
          if (e instanceof NotOffered) throw new ActionError(e.message, 422);
          if (e instanceof GitHubRefused) throw new ActionError(`GitHub refused: ${e.message}`, 502);
          throw e;
        }
        // The hide shows at once; what GitHub now says arrives with the next fetch.
        void cache.refresh(account, true);
        return c.json({ ok: true });
      }
      case "stale.ask": {
        if (!account) throw new ActionError("No GitHub account.");
        return c.json(await start(account, (input as { key: string }).key, "stale"));
      }
      case "agent.send": {
        const { key, text } = input as z.infer<(typeof HomeActions)["agent.send"]>;
        agents.send(key, text);
        return c.json({ ok: true });
      }
      case "agent.decide": {
        const { key, approvalId, allow } = input as z.infer<(typeof HomeActions)["agent.decide"]>;
        agents.decide(key, approvalId, allow);
        return c.json({ ok: true });
      }
      case "agent.handoff":
        return c.json({ command: await agents.handOff((input as { key: string }).key) });
    }
  });

  /** Live updates for the home page and agent panels: "home" to refetch, "agent" with a session's new state. */
  app.get("/events", (c) =>
    streamSSE(c, async (stream) => {
      let open = true;
      let timer: NodeJS.Timeout | null = null;
      const onHome = () => {
        if (timer || !open) return;
        timer = setTimeout(() => {
          timer = null;
          if (open) void stream.writeSSE({ event: "home", data: "{}" });
        }, 150);
      };
      const onAgent = (key: string) => {
        const v = agents.view(key);
        if (open && v) void stream.writeSSE({ event: "agent", data: JSON.stringify(v) });
      };
      home.bus.on("changed", onHome);
      agents.bus.on("changed", onAgent);
      stream.onAbort(() => {
        open = false;
        home.bus.off("changed", onHome);
        agents.bus.off("changed", onAgent);
      });
      while (open) {
        await stream.sleep(25_000);
        if (open) void stream.writeSSE({ event: "ping", data: "{}" });
      }
    }),
  );

  return app;
}
