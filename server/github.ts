// The open pull requests an account is part of, read from GitHub in one round
// of searches and reduced to PrFacts, plus what the account itself has been
// doing lately (its event feed), which is the best read of what it's focused on.
import { z } from "zod";
import { PrFacts, type Checks, type Mergeable, type ReviewDecision, type Touch } from "../domain/inbox.ts";
import { ghAsync } from "./gh.ts";
import type { FileChange, PrDetail, Requested, ReviewState } from "../domain/pr-detail.ts";

const PR_FIELDS = `
  number title url updatedAt isDraft
  repository { nameWithOwner }
  baseRefName headRefName headRefOid
  reviewDecision mergeable
  author { __typename login avatarUrl(size: 48) ... on User { name } }
  stack { number size }
  stackEntry { position }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
  reviewThreads(first: 100) { nodes { isResolved } }
  latestReviews(first: 30) { nodes { author { login } state commit { oid } } }
`;

const QUERY = `query($q: String!) { search(query: $q, type: ISSUE, first: 100) { nodes { ... on PullRequest { ${PR_FIELDS} } } } }`;

/**
 * Direct review requests only (`user-review-requested`): team and CODEOWNERS
 * requests are mostly noise, and an action list is only useful while it's short.
 * `reviewed-by` catches PRs you reviewed that changed since.
 */
const SEARCHES = [
  { q: "is:pr is:open archived:false user-review-requested:@me", requested: true },
  { q: "is:pr is:open archived:false reviewed-by:@me -author:@me", requested: false },
  { q: "is:pr is:open archived:false author:@me", requested: false },
] as const;

const Node = z.object({
  number: z.number(),
  title: z.string(),
  url: z.string(),
  updatedAt: z.string(),
  isDraft: z.boolean(),
  repository: z.object({ nameWithOwner: z.string() }),
  baseRefName: z.string(),
  headRefName: z.string(),
  headRefOid: z.string(),
  reviewDecision: z.enum(["APPROVED", "CHANGES_REQUESTED", "REVIEW_REQUIRED"]).nullable(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  author: z.object({ __typename: z.string(), login: z.string(), avatarUrl: z.string(), name: z.string().nullable().optional() }).nullable(),
  stack: z.object({ number: z.number(), size: z.number() }).nullable().optional(),
  stackEntry: z.object({ position: z.number() }).nullable().optional(),
  commits: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ state: z.string() }).nullable() }) })) }),
  reviewThreads: z.object({ nodes: z.array(z.object({ isResolved: z.boolean() })) }),
  latestReviews: z.object({ nodes: z.array(z.object({ author: z.object({ login: z.string() }).nullable(), state: z.string(), commit: z.object({ oid: z.string() }).nullable() })) }),
});
type Node = z.infer<typeof Node>;

const Response = z.object({ data: z.object({ search: z.object({ nodes: z.array(z.unknown()) }) }) });

const CHECKS: Record<string, Checks> = { SUCCESS: "passing", FAILURE: "failing", ERROR: "failing", PENDING: "pending", EXPECTED: "pending" };
const MERGEABLE: Record<Node["mergeable"], Mergeable> = { MERGEABLE: "mergeable", CONFLICTING: "conflicting", UNKNOWN: "unknown" };
const DECISION: Record<NonNullable<Node["reviewDecision"]>, ReviewDecision> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", REVIEW_REQUIRED: "review_required" };

function toFacts(node: Node, account: string, requested: boolean): PrFacts {
  const me = account.toLowerCase();
  const mine = node.latestReviews.nodes.find((r) => r.author?.login.toLowerCase() === me && r.state !== "PENDING");
  const rollup = node.commits.nodes[0]?.commit.statusCheckRollup?.state ?? null;
  return PrFacts.parse({
    repo: node.repository.nameWithOwner,
    number: node.number,
    title: node.title,
    url: node.url,
    author: node.author?.login ?? "ghost",
    authorKind: node.author?.__typename === "Bot" ? "bot" : "person",
    authorName: node.author?.name || null,
    authorAvatar: node.author?.avatarUrl ?? null,
    touched: null,
    isDraft: node.isDraft,
    updatedAt: node.updatedAt,
    baseRef: node.baseRefName,
    headRef: node.headRefName,
    headSha: node.headRefOid,
    reviewDecision: node.reviewDecision ? DECISION[node.reviewDecision] : null,
    checks: rollup ? (CHECKS[rollup] ?? "pending") : "none",
    mergeable: MERGEABLE[node.mergeable],
    unresolvedThreads: node.reviewThreads.nodes.filter((t) => !t.isResolved).length,
    role: node.author?.login.toLowerCase() === me ? "author" : "reviewer",
    reviewRequested: requested,
    myReviewSha: mine?.commit?.oid ?? null,
    stack: node.stack && node.stackEntry ? { number: node.stack.number, size: node.stack.size, position: node.stackEntry.position } : null,
  });
}

export async function fetchPrs(account: string): Promise<PrFacts[]> {
  const results = await Promise.all(
    SEARCHES.map(async ({ q, requested }) => {
      const out = await once(() => ghAsync(["api", "graphql", "-f", `q=${q}`, "-f", `query=${QUERY}`], { account }));
      return Response.parse(JSON.parse(out))
        .data.search.nodes.filter((n) => n && typeof n === "object" && "number" in n)
        .map((n) => toFacts(Node.parse(n), account, requested));
    }),
  );
  return results.flat();
}

/** GitHub search fails now and then for no reason it reports; one more try clears nearly all of them. */
async function once<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch {
    return run();
  }
}

const Event = z.object({
  type: z.string(),
  created_at: z.string(),
  repo: z.object({ name: z.string() }),
  payload: z.object({
    ref: z.string().nullable().optional(),
    pull_request: z.object({ number: z.number() }).optional(),
    issue: z.object({ number: z.number(), pull_request: z.unknown().optional() }).optional(),
  }),
});

const TOUCH_HOW: Record<string, Touch["how"]> = {
  PullRequestReviewEvent: "reviewed",
  PullRequestReviewCommentEvent: "commented",
  IssueCommentEvent: "commented",
  PullRequestEvent: "opened",
  PushEvent: "pushed",
};

/** What the account did on GitHub in roughly the last week: up to 300 events, newest first. */
export async function fetchTouches(account: string): Promise<Touch[]> {
  const out = await once(() => ghAsync(["api", `/users/${account}/events?per_page=100`, "--paginate", "--slurp"], { account }));
  const events = z.array(z.array(Event)).parse(JSON.parse(out)).flat();
  const touches = events.flatMap((e): Touch[] => {
    const how = TOUCH_HOW[e.type];
    if (!how) return [];
    const number = e.payload.pull_request?.number ?? (e.payload.issue?.pull_request ? e.payload.issue.number : undefined);
    const branch = e.type === "PushEvent" ? e.payload.ref?.replace(/^refs\/heads\//, "") : undefined;
    if (number === undefined && !branch) return [];
    return [{ repo: e.repo.name, number: number ?? null, branch: branch ?? null, at: e.created_at, how, author: null }];
  });
  return withAuthors(touches, account);
}

/** The event feed leaves out whose PR it was; one query fills that in, so "who you're working with" includes merged PRs. */
async function withAuthors(touches: Touch[], account: string): Promise<Touch[]> {
  const prs = [...new Map(touches.filter((t) => t.number !== null).map((t) => [`${t.repo}#${t.number}`, t])).values()].slice(0, 60);
  if (prs.length === 0) return touches;
  const fields = prs.map((t, i) => {
    const [owner, name] = t.repo.split("/");
    return `p${i}: repository(owner: ${JSON.stringify(owner)}, name: ${JSON.stringify(name)}) { pullRequest(number: ${t.number}) { author { login } } }`;
  });
  const out = await ghAsync(["api", "graphql", "-f", `query=query { ${fields.join("\n")} }`], { account }).catch(() => null);
  if (!out) return touches;
  const data = (JSON.parse(out) as { data?: Record<string, { pullRequest: { author: { login: string } | null } | null } | null> }).data ?? {};
  const authors = new Map(prs.map((t, i) => [`${t.repo}#${t.number}`, data[`p${i}`]?.pullRequest?.author?.login ?? null]));
  return touches.map((t) => (t.number === null ? t : { ...t, author: authors.get(`${t.repo}#${t.number}`) ?? null }));
}

/** The account's avatar, for the account menu. */
export async function fetchAvatar(account: string): Promise<string | null> {
  const out = await ghAsync(["api", "user", "--jq", ".avatar_url"], { account }).catch(() => "");
  return out.trim() || null;
}

const PERSON = "login avatarUrl(size: 40) ... on User { name }";
const DETAIL_QUERY = `query($owner: String!, $name: String!, $number: Int!) { repository(owner: $owner, name: $name) { pullRequest(number: $number) {
  body additions deletions changedFiles createdAt
  commitCount: commits { totalCount }
  files(first: 100) { nodes { path additions deletions changeType } }
  latestReviews(first: 30) { nodes { author { ${PERSON} } state } }
  reviewRequests(first: 30) { nodes { requestedReviewer { __typename ... on User { login name avatarUrl(size: 40) } ... on Bot { login avatarUrl(size: 40) } ... on Team { name } } } }
  lastCommit: commits(last: 1) { nodes { commit { statusCheckRollup { contexts(first: 100) { nodes { __typename ... on CheckRun { name conclusion status } ... on StatusContext { context state } } } } } } }
} } }`;

const Author = z.object({ login: z.string(), avatarUrl: z.string().optional(), name: z.string().nullable().optional() });
const Detail = z.object({
  body: z.string(),
  additions: z.number(),
  deletions: z.number(),
  changedFiles: z.number(),
  createdAt: z.string(),
  commitCount: z.object({ totalCount: z.number() }),
  files: z.object({ nodes: z.array(z.object({ path: z.string(), additions: z.number(), deletions: z.number(), changeType: z.string() })) }).nullable(),
  latestReviews: z.object({ nodes: z.array(z.object({ author: Author.nullable(), state: z.string() })) }),
  reviewRequests: z.object({ nodes: z.array(z.object({ requestedReviewer: z.object({ __typename: z.string(), login: z.string().optional(), name: z.string().nullable().optional(), avatarUrl: z.string().optional() }).nullable() })) }).nullable(),
  lastCommit: z.object({ nodes: z.array(z.object({ commit: z.object({ statusCheckRollup: z.object({ contexts: z.object({ nodes: z.array(z.object({ __typename: z.string(), name: z.string().optional(), conclusion: z.string().nullable().optional(), status: z.string().optional(), context: z.string().optional(), state: z.string().optional() })) }) }).nullable() }) })) }),
});

const REVIEW_STATE: Record<string, ReviewState> = { APPROVED: "approved", CHANGES_REQUESTED: "changes_requested", COMMENTED: "commented", DISMISSED: "dismissed" };
const CHANGE: Record<string, FileChange["change"]> = { ADDED: "added", DELETED: "deleted", MODIFIED: "modified", RENAMED: "renamed", COPIED: "copied" };
const FAILED = new Set(["FAILURE", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE", "ERROR"]);
const PASSED = new Set(["SUCCESS", "NEUTRAL"]);

/** One PR in full, for the preview. */
export async function fetchDetail(account: string, repo: string, number: number): Promise<PrDetail> {
  const [owner, name] = repo.split("/");
  const out = await once(() => ghAsync(["api", "graphql", "-F", `owner=${owner}`, "-F", `name=${name}`, "-F", `number=${number}`, "-f", `query=${DETAIL_QUERY}`], { account }));
  const pr = Detail.parse((JSON.parse(out) as { data: { repository: { pullRequest: unknown } } }).data.repository.pullRequest);
  const checks = { passing: 0, failing: [] as string[], pending: [] as string[] };
  for (const c of pr.lastCommit.nodes[0]?.commit.statusCheckRollup?.contexts.nodes ?? []) {
    const label = c.name ?? c.context ?? "check";
    const outcome = c.__typename === "CheckRun" ? (c.status === "COMPLETED" ? (c.conclusion ?? "") : "PENDING") : (c.state ?? "");
    if (FAILED.has(outcome)) checks.failing.push(label);
    else if (PASSED.has(outcome)) checks.passing++;
    else if (outcome === "PENDING" || outcome === "EXPECTED") checks.pending.push(label);
  }
  const requested = (pr.reviewRequests?.nodes ?? []).flatMap((r): Requested[] => {
    const who = r.requestedReviewer;
    if (!who) return [];
    if (who.__typename === "Team") return [{ kind: "team", name: who.name ?? "team" }];
    return [{ kind: "person", login: who.login ?? "ghost", name: who.name ?? null, avatar: who.avatarUrl ?? null }];
  });
  return {
    body: pr.body,
    createdAt: pr.createdAt,
    additions: pr.additions,
    deletions: pr.deletions,
    changedFiles: pr.changedFiles,
    commits: pr.commitCount.totalCount,
    files: (pr.files?.nodes ?? []).map((f) => ({ path: f.path, additions: f.additions, deletions: f.deletions, change: CHANGE[f.changeType] ?? "changed" })),
    reviews: pr.latestReviews.nodes.flatMap((r) => (r.author && REVIEW_STATE[r.state] ? [{ login: r.author.login, name: r.author.name ?? null, avatar: r.author.avatarUrl ?? null, state: REVIEW_STATE[r.state]! }] : [])),
    requested,
    checks,
  };
}
