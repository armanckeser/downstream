// The inbox: every open pull request you're part of, reduced to the one thing
// it needs from you next (Getting Things Done: one next action each; what waits
// on someone else goes to its own list), then sorted into the Eisenhower matrix:
// urgent when a person is blocked on you, important when it's part of what
// you're working on. Downstream makes the first read; yours replaces it.
import { z } from "zod";

export const Checks = z.enum(["passing", "failing", "pending", "none"]);
export type Checks = z.infer<typeof Checks>;

export const Mergeable = z.enum(["mergeable", "conflicting", "unknown"]);
export type Mergeable = z.infer<typeof Mergeable>;

export const ReviewDecision = z.enum(["approved", "changes_requested", "review_required"]);
export type ReviewDecision = z.infer<typeof ReviewDecision>;

const TouchAt = z.object({ at: z.string(), how: z.enum(["reviewed", "commented", "opened", "pushed"]) });

/** A pull request as GitHub describes it, from the point of view of one account. */
export const PrFacts = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  url: z.string(),
  author: z.string(),
  /** Bots (GitHub Apps) open PRs as your delegated work, not as someone waiting on you. */
  authorKind: z.enum(["person", "bot"]),
  /** What people call the author ("Annie Edison"), when GitHub knows it. */
  authorName: z.string().nullable(),
  authorAvatar: z.string().nullable(),
  isDraft: z.boolean(),
  updatedAt: z.string(),
  baseRef: z.string(),
  headRef: z.string(),
  headSha: z.string(),
  reviewDecision: ReviewDecision.nullable(),
  checks: Checks,
  mergeable: Mergeable,
  unresolvedThreads: z.number().int(),
  /** Whether this account wrote the PR or is (or was) asked to review it. */
  role: z.enum(["author", "reviewer"]),
  /** A review from this account is requested right now. */
  reviewRequested: z.boolean(),
  /** The commit this account last reviewed, if it ever did. */
  myReviewSha: z.string().nullable(),
  /** GitHub's native stacks (`gh stack`): position 1 sits on the base branch. */
  stack: z.object({ number: z.number().int(), size: z.number().int(), position: z.number().int() }).nullable(),
  /** The last time this account reviewed, commented on, opened or pushed to it, from its event feed. */
  touched: TouchAt.nullable(),
});
export type PrFacts = z.infer<typeof PrFacts>;

/** One thing the account did, from its GitHub event feed. Pushes name a branch; the rest name a PR and, when known, its author. */
export type Touch = z.infer<typeof TouchAt> & { repo: string; number: number | null; branch: string | null; author: string | null };

/** Attach each PR's latest touch. `touches` is newest first, as GitHub returns it. */
export function withTouches(prs: PrFacts[], touches: Touch[]): PrFacts[] {
  return prs.map((pr) => {
    const hit = touches.find((t) => t.repo === pr.repo && (t.number === pr.number || (t.branch !== null && t.branch === pr.headRef)));
    return hit ? { ...pr, touched: { at: hit.at, how: hit.how } } : pr;
  });
}

export type WaitingOn = "author" | "reviewers" | "checks" | "lower-layer";

/** The one next action. `waiting` means the next action is someone else's. */
export type Move =
  | { kind: "merge" }
  | { kind: "review" }
  | { kind: "rereview" }
  | { kind: "address-feedback"; threads: number }
  | { kind: "resolve-conflicts" }
  | { kind: "fix-checks" }
  | { kind: "finish-draft" }
  | { kind: "waiting"; on: WaitingOn };

export type MoveKind = Move["kind"];

/**
 * How each move reads and what pressing it does. `review` opens Downstream with
 * the agent; `agent` starts the agent on the task; `github` opens the PR.
 * Rank orders the action list: two-minute actions first (GTD's two-minute rule),
 * then whoever is blocked on you, then your own fixes.
 */
export const MOVES: Record<MoveKind, { verb: string; rank: number; opens: "review" | "agent" | "github" }> = {
  merge: { verb: "Merge", rank: 0, opens: "github" },
  review: { verb: "Review", rank: 1, opens: "review" },
  rereview: { verb: "Re-review", rank: 2, opens: "review" },
  "address-feedback": { verb: "Address feedback", rank: 3, opens: "agent" },
  "resolve-conflicts": { verb: "Resolve conflicts", rank: 4, opens: "agent" },
  "fix-checks": { verb: "Fix checks", rank: 5, opens: "agent" },
  "finish-draft": { verb: "Finish draft", rank: 6, opens: "agent" },
  waiting: { verb: "Waiting", rank: 99, opens: "github" },
};

export const WAITING_ON: Record<WaitingOn, string> = {
  author: "the author",
  reviewers: "reviewers",
  checks: "checks",
  "lower-layer": "the PR below it",
};

/** The next action for a single PR, ignoring the stack it may sit in. */
export function moveFor(pr: PrFacts): Move {
  if (pr.role === "reviewer") {
    const reviewed = pr.myReviewSha !== null;
    if (reviewed && pr.myReviewSha !== pr.headSha) return { kind: "rereview" };
    if (pr.reviewRequested) return { kind: "review" };
    return { kind: "waiting", on: "author" };
  }
  if (pr.mergeable === "conflicting") return { kind: "resolve-conflicts" };
  if (pr.checks === "failing") return { kind: "fix-checks" };
  if (pr.reviewDecision === "changes_requested" || pr.unresolvedThreads > 0) return { kind: "address-feedback", threads: pr.unresolvedThreads };
  if (pr.isDraft) return { kind: "finish-draft" };
  if (pr.checks === "pending") return { kind: "waiting", on: "checks" };
  if (pr.reviewDecision === "approved" && pr.mergeable === "mergeable") return { kind: "merge" };
  return { kind: "waiting", on: "reviewers" };
}

/** One thing on the list: a lone PR, or a stack you work bottom to top. */
export type Item = {
  key: string;
  repo: string;
  /** Bottom to top. A lone PR is a list of one. */
  prs: PrFacts[];
  /** The PR the move is about. */
  lead: PrFacts;
  move: Move;
  stack: { number: number; size: number } | null;
};

export const itemKey = (pr: PrFacts) => (pr.stack ? `${pr.repo}@${pr.stack.number}` : `${pr.repo}#${pr.number}`);

/**
 * Group PRs into items. In a stack only the lowest layer can merge, so an
 * approved layer above an open one waits on it; the stack's move is the move
 * of its lowest layer that needs something from you.
 */
export function toItems(prs: PrFacts[]): Item[] {
  const groups = Map.groupBy(dedupe(prs), itemKey);
  return [...groups.entries()].map(([key, group]) => {
    const layers = [...group].sort((a, b) => (a.stack?.position ?? 0) - (b.stack?.position ?? 0));
    const moves = layers.map((pr, i): Move => {
      const move = moveFor(pr);
      if (move.kind === "merge" && i > 0) return { kind: "waiting", on: "lower-layer" };
      return move;
    });
    const actionable = moves.findIndex((m) => m.kind !== "waiting");
    const at = actionable === -1 ? 0 : actionable;
    const first = layers[0]!;
    return {
      key,
      repo: first.repo,
      prs: layers,
      lead: layers[at]!,
      move: moves[at]!,
      stack: first.stack ? { number: first.stack.number, size: first.stack.size } : null,
    };
  });
}

/**
 * The same PR can come back from several searches (requested, and reviewed
 * before). Keep one: a pending request wins.
 */
function dedupe(prs: PrFacts[]): PrFacts[] {
  const byKey = new Map<string, PrFacts>();
  for (const pr of prs) {
    const key = `${pr.repo}#${pr.number}`;
    const seen = byKey.get(key);
    byKey.set(key, seen ? { ...seen, reviewRequested: seen.reviewRequested || pr.reviewRequested, myReviewSha: seen.myReviewSha ?? pr.myReviewSha } : pr);
  }
  return [...byKey.values()];
}

export const Quadrant = z.enum(["do", "next", "delegate", "someday"]);
export type Quadrant = z.infer<typeof Quadrant>;

/** Why an item sits where it does, in the words the row shows. */
export type Why =
  | { kind: "in-focus"; at: string; how: Touch["how"] }
  | { kind: "person-waiting"; who: string; since: string; engaged: boolean }
  | { kind: "feedback-on-yours" }
  | { kind: "ready-to-merge" }
  | { kind: "yours" }
  | { kind: "bot-work"; who: string }
  | { kind: "draft" }
  | { kind: "quiet"; since: string }
  | { kind: "you-chose" };

export type Triaged = Item & { quadrant: Quadrant; why: Why; auto: { quadrant: Quadrant; why: Why } };

/** Touched in the last three days: what you're in the middle of. */
const FOCUS_WINDOW_MS = 3 * 24 * 3600_000;
/** No activity from anyone for two weeks: it has gone quiet, whatever its state says. */
const QUIET_AFTER_MS = 14 * 24 * 3600_000;

const latestTouch = (item: Item) =>
  item.prs.map((p) => p.touched).filter((t) => t !== null).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
const lastActivity = (item: Item) => [...item.prs.map((p) => p.updatedAt), latestTouch(item)?.at ?? ""].sort().at(-1)!;

/**
 * Downstream's read of one item. Urgent: a person is blocked on you (their
 * review, feedback on your PR) or it's done and only needs merging. Important:
 * you're working on it or near it (touched lately, or you touched another PR by
 * the same author), you reviewed it before, or it's yours. What you've left
 * alone says "someday": drafts you haven't opened lately, anything gone quiet.
 */
export function triage(item: Item, context: { now: Date; focusAuthors: Set<string> }): { quadrant: Quadrant; why: Why } {
  const now = context.now.getTime();
  const pr = item.lead;
  const touch = latestTouch(item);
  const inFocus = touch !== null && now - Date.parse(touch.at) <= FOCUS_WINDOW_MS;
  if (inFocus) return { quadrant: "do", why: { kind: "in-focus", at: touch.at, how: touch.how } };
  if (now - Date.parse(lastActivity(item)) > QUIET_AFTER_MS) return { quadrant: "someday", why: { kind: "quiet", since: lastActivity(item) } };
  if (pr.isDraft) return { quadrant: "someday", why: { kind: "draft" } };

  const yours = pr.role === "author";
  if (yours && item.move.kind === "merge") return { quadrant: "do", why: { kind: "ready-to-merge" } };
  if (yours && item.move.kind === "address-feedback") return { quadrant: "do", why: { kind: "feedback-on-yours" } };
  if (yours) return { quadrant: "next", why: { kind: "yours" } };
  if (pr.authorKind === "bot") return { quadrant: "next", why: { kind: "bot-work", who: pr.author } };

  const engaged = item.move.kind === "rereview";
  const waiting: Why = { kind: "person-waiting", who: pr.authorName ?? pr.author, since: pr.updatedAt, engaged };
  const important = engaged || context.focusAuthors.has(pr.author);
  return { quadrant: important ? "do" : "delegate", why: waiting };
}

export type Inbox = {
  /** The one thing to do first. Null only when nothing needs you. */
  top: Triaged | null;
  do: Triaged[];
  next: Triaged[];
  delegate: Triaged[];
  someday: Triaged[];
  /** Waiting on someone else: not yours to act on. */
  waiting: Item[];
};

/**
 * Your choices, by item key, with when you made them. A choice outlives
 * Downstream's read, with one exception: Someday is "until something happens",
 * so activity on the PR after you chose it brings the PR back to a fresh read.
 */
export type Choices = Record<string, { quadrant: Quadrant; at: string }>;

/**
 * Read every item, apply your choices over the reads, and order each quadrant.
 * `touches` names who you've been working with: the authors of PRs you touched
 * lately, including ones already merged.
 */
export function arrange(items: Item[], choices: Choices, now: Date, touches: Touch[]): Inbox {
  const actionable = items.filter((i) => i.move.kind !== "waiting");
  const recent = touches.filter((t) => now.getTime() - Date.parse(t.at) <= FOCUS_WINDOW_MS);
  const focusAuthors = new Set(recent.map((t) => t.author).filter((a) => a !== null));
  const triaged = actionable.map((item): Triaged => {
    const auto = triage(item, { now, focusAuthors });
    const chosen = choices[item.key];
    const woke = chosen?.quadrant === "someday" && lastActivity(item) > chosen.at;
    return chosen && !woke && chosen.quadrant !== auto.quadrant ? { ...item, quadrant: chosen.quadrant, why: { kind: "you-chose" }, auto } : { ...item, ...auto, auto };
  });
  const of = (q: Quadrant) => triaged.filter((t) => t.quadrant === q).sort(ORDER[q]);
  const inbox = { do: of("do"), next: of("next"), delegate: of("delegate"), someday: of("someday") };
  return {
    top: inbox.do[0] ?? inbox.next[0] ?? inbox.delegate[0] ?? null,
    ...inbox,
    waiting: items.filter((i) => i.move.kind === "waiting").sort((a, b) => b.lead.updatedAt.localeCompare(a.lead.updatedAt)),
  };
}

const oldestFirst = (a: Item, b: Item) => a.lead.updatedAt.localeCompare(b.lead.updatedAt);
const newestFirst = (a: Item, b: Item) => b.lead.updatedAt.localeCompare(a.lead.updatedAt);
const byMove = (a: Item, b: Item) => MOVES[a.move.kind].rank - MOVES[b.move.kind].rank;

/** Do: people blocked on you first, longest wait first (they can't move without you); then what you're in the middle of, latest first. */
const DO_ORDER: Record<Why["kind"], number> = { "person-waiting": 0, "feedback-on-yours": 1, "ready-to-merge": 2, "you-chose": 3, "in-focus": 4, yours: 5, "bot-work": 5, draft: 6, quiet: 6 };

const ORDER: Record<Quadrant, (a: Triaged, b: Triaged) => number> = {
  do: (a, b) => DO_ORDER[a.why.kind] - DO_ORDER[b.why.kind] || (a.why.kind === "in-focus" && b.why.kind === "in-focus" ? b.why.at.localeCompare(a.why.at) : oldestFirst(a, b)),
  next: (a, b) => byMove(a, b) || newestFirst(a, b),
  delegate: oldestFirst,
  someday: newestFirst,
};
