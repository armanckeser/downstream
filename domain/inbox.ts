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

/** What the author did after your last review that hands the PR back to you. */
const AuthorAct = z.object({ how: z.enum(["pushed", "replied"]), at: z.string() });

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
  /** When this account last reviewed, if it ever did. */
  myReviewAt: z.string().nullable(),
  /** The author's latest push or reply after that review. Null when there is none, or no review. */
  authorSince: AuthorAct.nullable(),
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

/** Why a PR you reviewed is your turn again. */
export type TurnBack = { how: z.infer<typeof AuthorAct>["how"] | "re-requested"; at: string };

/** The one next action. `waiting` means the next action is someone else's. */
export type Move =
  | { kind: "merge" }
  | { kind: "review" }
  | { kind: "rereview"; because: TurnBack }
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

/**
 * The next action for a single PR, ignoring the stack it may sit in. Once you
 * have reviewed, the PR is the author's turn until they push, reply or ask you
 * again. Commit ids can't tell this: a review posted on a commit the author
 * force-pushed away mid-review would look like new work forever.
 */
export function moveFor(pr: PrFacts): Move {
  if (pr.role === "reviewer") return reviewerMove(pr);
  if (pr.mergeable === "conflicting") return { kind: "resolve-conflicts" };
  if (pr.checks === "failing") return { kind: "fix-checks" };
  if (pr.reviewDecision === "changes_requested" || pr.unresolvedThreads > 0) return { kind: "address-feedback", threads: pr.unresolvedThreads };
  if (pr.isDraft) return { kind: "finish-draft" };
  if (pr.checks === "pending") return { kind: "waiting", on: "checks" };
  if (pr.reviewDecision === "approved" && pr.mergeable === "mergeable") return { kind: "merge" };
  return { kind: "waiting", on: "reviewers" };
}

function reviewerMove(pr: PrFacts): Move {
  if (pr.myReviewAt === null) return pr.reviewRequested ? { kind: "review" } : { kind: "waiting", on: "author" };
  // Reviewing fulfils a request, so a request standing after your review was made again.
  if (pr.reviewRequested) return { kind: "rereview", because: { how: "re-requested", at: pr.updatedAt } };
  if (pr.authorSince) return { kind: "rereview", because: pr.authorSince };
  return { kind: "waiting", on: "author" };
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
    byKey.set(
      key,
      seen
        ? { ...seen, reviewRequested: seen.reviewRequested || pr.reviewRequested, myReviewAt: seen.myReviewAt ?? pr.myReviewAt, authorSince: seen.authorSince ?? pr.authorSince }
        : pr,
    );
  }
  return [...byKey.values()];
}

export const Quadrant = z.enum(["do", "next", "delegate", "someday"]);
export type Quadrant = z.infer<typeof Quadrant>;

/** Why an item sits where it does, in the words the row shows. */
export type Why =
  | { kind: "your-turn"; who: string; how: TurnBack["how"]; at: string }
  | { kind: "in-focus"; at: string; how: Touch["how"] }
  | { kind: "person-waiting"; who: string; since: string }
  | { kind: "feedback-on-yours" }
  | { kind: "ready-to-merge" }
  | { kind: "yours" }
  | { kind: "bot-work"; who: string }
  | { kind: "draft" }
  | { kind: "you-chose" };

export type Triaged = Item & { quadrant: Quadrant; why: Why; auto: { quadrant: Quadrant; why: Why } };

/** Touched in the last three days: what you're in the middle of. */
const FOCUS_WINDOW_MS = 3 * 24 * 3600_000;
/** No activity from anyone for two weeks: it has gone stale, whatever its state says, and needs a decision rather than a slot. */
const QUIET_AFTER_MS = 14 * 24 * 3600_000;

const latestTouch = (item: Item) =>
  item.prs.map((p) => p.touched).filter((t) => t !== null).sort((a, b) => b.at.localeCompare(a.at))[0] ?? null;
const lastActivity = (item: Item) => [...item.prs.map((p) => p.updatedAt), latestTouch(item)?.at ?? ""].sort().at(-1)!;

/**
 * Downstream's read of one item. Urgent: a person is blocked on you (their
 * review, feedback on your PR) or it's done and only needs merging. Important:
 * you're working on it or near it (touched lately, or you touched another PR by
 * the same author), or it's yours. A PR handed back after your review is both.
 * Drafts you haven't opened lately say "someday". Stale PRs never reach here.
 */
export function triage(item: Item, context: { now: Date; focusAuthors: Set<string> }): { quadrant: Quadrant; why: Why } {
  const now = context.now.getTime();
  const pr = item.lead;
  // Before focus: "you reviewed 1h ago" would hide that the author answered since.
  if (item.move.kind === "rereview") return { quadrant: "do", why: { kind: "your-turn", who: pr.authorName ?? pr.author, ...item.move.because } };
  const touch = latestTouch(item);
  const inFocus = touch !== null && now - Date.parse(touch.at) <= FOCUS_WINDOW_MS;
  if (inFocus) return { quadrant: "do", why: { kind: "in-focus", at: touch.at, how: touch.how } };
  if (pr.isDraft) return { quadrant: "someday", why: { kind: "draft" } };

  const yours = pr.role === "author";
  if (yours && item.move.kind === "merge") return { quadrant: "do", why: { kind: "ready-to-merge" } };
  if (yours && item.move.kind === "address-feedback") return { quadrant: "do", why: { kind: "feedback-on-yours" } };
  if (yours) return { quadrant: "next", why: { kind: "yours" } };
  if (pr.authorKind === "bot") return { quadrant: "next", why: { kind: "bot-work", who: pr.author } };

  const waiting: Why = { kind: "person-waiting", who: pr.authorName ?? pr.author, since: pr.updatedAt };
  return { quadrant: context.focusAuthors.has(pr.author) ? "do" : "delegate", why: waiting };
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
  /** Nothing from anyone for two weeks, oldest first: each needs a decision, one at a time. */
  stale: Item[];
};

/**
 * Your choices, by item key, with when you made them. A choice outlives
 * Downstream's read, with two exceptions that mean "until something happens":
 * Someday, and hidden (hidden from every list). Activity on the PR after you
 * chose either brings it back to a fresh read.
 */
export type Placement = Quadrant | "hidden";
export type Choices = Record<string, { quadrant: Placement; at: string }>;

const UNTIL_IT_CHANGES: ReadonlySet<Placement> = new Set(["someday", "hidden"]);

/**
 * Read every item, apply your choices over the reads, and order each quadrant.
 * `touches` names who you've been working with: the authors of PRs you touched
 * lately, including ones already merged.
 */
export function arrange(items: Item[], choices: Choices, now: Date, touches: Touch[]): Inbox {
  const standing = (item: Item) => {
    const chosen = choices[item.key];
    const woke = chosen !== undefined && UNTIL_IT_CHANGES.has(chosen.quadrant) && lastActivity(item) > chosen.at;
    return chosen && !woke ? chosen.quadrant : null;
  };
  const shown = items.filter((i) => standing(i) !== "hidden");
  const isStale = (i: Item) => now.getTime() - Date.parse(lastActivity(i)) > QUIET_AFTER_MS;
  const stale = shown.filter(isStale).sort((a, b) => lastActivity(a).localeCompare(lastActivity(b)));
  const fresh = shown.filter((i) => !isStale(i));
  const actionable = fresh.filter((i) => i.move.kind !== "waiting");
  const recent = touches.filter((t) => now.getTime() - Date.parse(t.at) <= FOCUS_WINDOW_MS);
  const focusAuthors = new Set(recent.map((t) => t.author).filter((a) => a !== null));
  const triaged = actionable.map((item): Triaged => {
    const auto = triage(item, { now, focusAuthors });
    const chosen = standing(item);
    return chosen && chosen !== "hidden" && chosen !== auto.quadrant ? { ...item, quadrant: chosen, why: { kind: "you-chose" }, auto } : { ...item, ...auto, auto };
  });
  const of = (q: Quadrant) => triaged.filter((t) => t.quadrant === q).sort(ORDER[q]);
  const inbox = { do: of("do"), next: of("next"), delegate: of("delegate"), someday: of("someday") };
  return {
    top: inbox.do[0] ?? inbox.next[0] ?? inbox.delegate[0] ?? null,
    ...inbox,
    waiting: fresh.filter((i) => i.move.kind === "waiting").sort((a, b) => b.lead.updatedAt.localeCompare(a.lead.updatedAt)),
    stale,
  };
}

/** When the person on the other side last handed it to you. */
const waitedLongest = (t: Triaged) => (t.why.kind === "your-turn" ? t.why.at : t.lead.updatedAt);
const oldestFirst = (a: Item, b: Item) => a.lead.updatedAt.localeCompare(b.lead.updatedAt);
const newestFirst = (a: Item, b: Item) => b.lead.updatedAt.localeCompare(a.lead.updatedAt);
const byMove = (a: Item, b: Item) => MOVES[a.move.kind].rank - MOVES[b.move.kind].rank;

/** Do: people blocked on you first, longest wait first (they can't move without you); then what you're in the middle of, latest first. */
const DO_ORDER: Record<Why["kind"], number> = { "your-turn": 0, "person-waiting": 0, "feedback-on-yours": 1, "ready-to-merge": 2, "you-chose": 3, "in-focus": 4, yours: 5, "bot-work": 5, draft: 6 };

const ORDER: Record<Quadrant, (a: Triaged, b: Triaged) => number> = {
  do: (a, b) => DO_ORDER[a.why.kind] - DO_ORDER[b.why.kind] || (a.why.kind === "in-focus" && b.why.kind === "in-focus" ? b.why.at.localeCompare(a.why.at) : waitedLongest(a).localeCompare(waitedLongest(b))),
  next: (a, b) => byMove(a, b) || newestFirst(a, b),
  delegate: oldestFirst,
  someday: newestFirst,
};

/** What a stale PR can be decided into. Skip isn't one: it decides nothing. */
export type StaleChoice =
  /** GitHub: deletes your review request. Here: hidden until it changes. */
  | { kind: "remove-request" }
  /** GitHub: posts a comment you write first. Here: hidden until it changes. */
  | { kind: "comment"; to: "author" | "reviewers" }
  /** GitHub: closes your PR with your reason as a comment. */
  | { kind: "close" }
  /** Here only. `nextMove: "yours"` means nobody else will act, so it may never come back. */
  | { kind: "hide"; nextMove: "yours" | "theirs" }
  /** Starts the agent on the thread; it posts nothing. */
  | { kind: "ask-agent" };

/** The choices a stale item offers, in the order they're shown. */
export function staleChoices(item: Item): StaleChoice[] {
  const pr = item.lead;
  const hide: StaleChoice = { kind: "hide", nextMove: item.move.kind === "waiting" ? "theirs" : "yours" };
  if (pr.role === "author") return [{ kind: "comment", to: "reviewers" }, { kind: "close" }, hide, { kind: "ask-agent" }];
  const request: StaleChoice[] = pr.reviewRequested ? [{ kind: "remove-request" }] : [];
  return [...request, { kind: "comment", to: "author" }, hide, { kind: "ask-agent" }];
}
