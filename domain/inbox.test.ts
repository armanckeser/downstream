// The inbox's rules, as a reader of the home page relies on them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { arrange, moveFor, toItems, withTouches, type PrFacts, type Touch } from "./inbox.ts";

/** Greendale's PRs. Every field is spelled out by the test that cares about it. */
function pr(overrides: Partial<PrFacts>): PrFacts {
  return {
    repo: "greendale/study-room",
    number: 1,
    title: "Paintball rules",
    url: "https://github.com/greendale/study-room/pull/1",
    author: "jeff",
    authorKind: "person",
    authorName: null,
    authorAvatar: null,
    isDraft: false,
    updatedAt: "2026-10-01T10:00:00Z",
    baseRef: "main",
    headRef: "paintball",
    headSha: "aaa",
    reviewDecision: null,
    checks: "passing",
    mergeable: "mergeable",
    unresolvedThreads: 0,
    role: "author",
    reviewRequested: false,
    myReviewSha: null,
    stack: null,
    touched: null,
    ...overrides,
  };
}

test("moveFor asks for a re-review when the author pushed after your review", () => {
  // Regression guarded: a PR you reviewed and that changed since looked identical
  // to one you'd already finished, so new commits waited on you unseen.
  const move = moveFor(pr({ role: "reviewer", reviewRequested: false, myReviewSha: "old", headSha: "new" }));
  assert.deepEqual(move, { kind: "rereview" });
});

test("moveFor waits on the author when you reviewed the latest commit and nobody asked again", () => {
  const move = moveFor(pr({ role: "reviewer", reviewRequested: false, myReviewSha: "same", headSha: "same" }));
  assert.deepEqual(move, { kind: "waiting", on: "author" });
});

test("moveFor asks for a review when you are re-requested without new commits", () => {
  const move = moveFor(pr({ role: "reviewer", reviewRequested: true, myReviewSha: "same", headSha: "same" }));
  assert.deepEqual(move, { kind: "review" });
});

test("moveFor does not offer merge while checks are still running", () => {
  // Regression guarded: an approved PR with pending checks offered Merge, and
  // pressing it merged before CI finished.
  const move = moveFor(pr({ reviewDecision: "approved", checks: "pending" }));
  assert.deepEqual(move, { kind: "waiting", on: "checks" });
});

test("moveFor offers merge when approved, green and mergeable", () => {
  assert.deepEqual(moveFor(pr({ reviewDecision: "approved", checks: "passing", mergeable: "mergeable" })), { kind: "merge" });
});

test("moveFor sends you to fix checks before addressing feedback", () => {
  const move = moveFor(pr({ checks: "failing", reviewDecision: "changes_requested", unresolvedThreads: 3 }));
  assert.deepEqual(move, { kind: "fix-checks" });
});

test("toItems keeps an approved upper layer waiting on the open layer below it", () => {
  // Regression guarded: every approved layer of a stack offered Merge, but only the
  // bottom one can merge; merging a top layer first lands it on the wrong base.
  const stack = { number: 7, size: 2 };
  const items = toItems([
    pr({ number: 11, reviewDecision: "approved", stack: { ...stack, position: 2 } }),
    pr({ number: 10, reviewDecision: "review_required", stack: { ...stack, position: 1 } }),
  ]);
  assert.equal(items.length, 1);
  const [item] = items;
  assert.deepEqual(item!.prs.map((p) => p.number), [10, 11]);
  assert.equal(item!.lead.number, 10);
  assert.deepEqual(item!.move, { kind: "waiting", on: "reviewers" });
});

test("toItems leads a stack with its lowest layer that needs you", () => {
  const stack = { number: 8, size: 3 };
  const items = toItems([
    pr({ number: 22, unresolvedThreads: 1, stack: { ...stack, position: 3 } }),
    pr({ number: 20, reviewDecision: "review_required", stack: { ...stack, position: 1 } }),
    pr({ number: 21, checks: "failing", stack: { ...stack, position: 2 } }),
  ]);
  assert.equal(items[0]!.lead.number, 21);
  assert.deepEqual(items[0]!.move, { kind: "fix-checks" });
});

test("toItems merges the same PR found by two searches, keeping the pending request", () => {
  const items = toItems([
    pr({ role: "reviewer", reviewRequested: false, myReviewSha: "aaa", headSha: "aaa" }),
    pr({ role: "reviewer", reviewRequested: true, myReviewSha: null, headSha: "aaa" }),
  ]);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0]!.move, { kind: "review" });
});

const NOW = new Date("2026-10-15T12:00:00Z");
const HOURS_AGO = (h: number) => new Date(NOW.getTime() - h * 3600_000).toISOString();
const DAYS_AGO = (d: number) => HOURS_AGO(d * 24);
const key = (n: number) => `greendale/study-room#${n}`;
const asReviewer = (overrides: Partial<PrFacts>) => pr({ role: "reviewer", reviewRequested: true, updatedAt: DAYS_AGO(1), ...overrides });

test("arrange puts a colleague's re-review first and your bot's old draft in later", () => {
  // Regression guarded: within a move the oldest PR went first, so a 48-day-old bot
  // draft was the suggested Now and the colleague PRs you were mid-review on sat 61st of 78.
  const items = toItems([
    asReviewer({ number: 1, author: "agent-abed", authorKind: "bot", isDraft: true, updatedAt: DAYS_AGO(48) }),
    asReviewer({ number: 2, author: "annie", reviewRequested: false, myReviewSha: "old", headSha: "new", updatedAt: HOURS_AGO(5) }),
  ]);
  const inbox = arrange(items, {}, NOW, []);
  assert.equal(inbox.top?.lead.number, 2);
  assert.deepEqual(inbox.top?.why, { kind: "person-waiting", who: "annie", since: HOURS_AGO(5), engaged: true });
  assert.deepEqual(inbox.someday.map((i) => i.lead.number), [1]);
  assert.deepEqual(inbox.someday[0]!.why, { kind: "quiet", since: DAYS_AGO(48) });
});

test("arrange puts what you pushed to in the last three days in do", () => {
  const prs = withTouches(
    [pr({ number: 3, headRef: "chang-chicken", isDraft: true, updatedAt: DAYS_AGO(20) })],
    [{ repo: "greendale/study-room", number: null, branch: "chang-chicken", at: HOURS_AGO(2), how: "pushed", author: null }],
  );
  const inbox = arrange(toItems(prs), {}, NOW, []);
  assert.deepEqual(inbox.do.map((i) => i.lead.number), [3]);
  assert.deepEqual(inbox.do[0]!.why, { kind: "in-focus", at: HOURS_AGO(2), how: "pushed" });
});

test("arrange leaves a PR out of focus when your last touch was four days ago", () => {
  const prs = withTouches([pr({ number: 4, isDraft: true, updatedAt: DAYS_AGO(4) })], [{ repo: "greendale/study-room", number: 4, branch: null, at: DAYS_AGO(4), how: "commented", author: "jeff" }]);
  const inbox = arrange(toItems(prs), {}, NOW, []);
  assert.deepEqual(inbox.do, []);
  assert.deepEqual(inbox.someday[0]!.why, { kind: "draft" });
});

test("withTouches ignores a push to a same-named branch in another repo", () => {
  const touches: Touch[] = [{ repo: "greendale/library", number: null, branch: "paintball", at: HOURS_AGO(1), how: "pushed", author: null }];
  assert.equal(withTouches([pr({ headRef: "paintball" })], touches)[0]!.touched, null);
});

test("arrange delegates a fresh request from someone outside your focus", () => {
  const items = toItems([asReviewer({ number: 5, author: "pierce" })]);
  const inbox = arrange(items, {}, NOW, []);
  assert.deepEqual(inbox.delegate.map((i) => i.lead.number), [5]);
  assert.deepEqual(inbox.do, []);
});

test("arrange keeps a fresh request in do when you're working with its author this week", () => {
  // Regression guarded: a new request from the colleague whose (now merged) PRs you
  // reviewed today landed in delegate, as if it came from a stranger.
  const items = toItems([asReviewer({ number: 7, author: "britta" })]);
  const touches: Touch[] = [{ repo: "greendale/study-room", number: 6, branch: null, at: HOURS_AGO(3), how: "reviewed", author: "britta" }];
  const inbox = arrange(items, {}, NOW, touches);
  assert.deepEqual(inbox.do.map((i) => i.lead.number), [7]);
  assert.deepEqual(inbox.delegate, []);
});

test("arrange keeps your choice over its own read and remembers the read", () => {
  const items = toItems([asReviewer({ number: 8, author: "annie", reviewRequested: false, myReviewSha: "old", headSha: "new", updatedAt: HOURS_AGO(5) })]);
  const inbox = arrange(items, { [key(8)]: { quadrant: "someday", at: HOURS_AGO(1) } }, NOW, []);
  assert.deepEqual(inbox.do, []);
  assert.equal(inbox.someday[0]!.why.kind, "you-chose");
  assert.equal(inbox.someday[0]!.auto.quadrant, "do");
});

test("arrange ignores a choice for a PR that is no longer open", () => {
  const items = toItems([asReviewer({ number: 9, author: "annie", reviewRequested: false, myReviewSha: "old", headSha: "new" })]);
  const inbox = arrange(items, { [key(99)]: { quadrant: "someday", at: HOURS_AGO(1) } }, NOW, []);
  assert.equal(inbox.top?.lead.number, 9);
});

test("arrange has nothing on top when everything waits on someone else", () => {
  const items = toItems([asReviewer({ reviewRequested: false, myReviewSha: "aaa", headSha: "aaa" })]);
  const inbox = arrange(items, {}, NOW, []);
  assert.equal(inbox.top, null);
  assert.equal(inbox.waiting.length, 1);
});

test("arrange brings a PR back from someday when something happens on it after you chose", () => {
  // Regression guarded: a PR you set aside stayed hidden after its author pushed and asked you again.
  const items = toItems([asReviewer({ number: 10, author: "annie", reviewRequested: false, myReviewSha: "old", headSha: "new", updatedAt: HOURS_AGO(1) })]);
  const inbox = arrange(items, { [key(10)]: { quadrant: "someday", at: HOURS_AGO(6) } }, NOW, []);
  assert.deepEqual(inbox.do.map((i) => i.lead.number), [10]);
  assert.deepEqual(inbox.someday, []);
});

test("arrange keeps your next choice even after the PR changes", () => {
  const items = toItems([asReviewer({ number: 11, author: "pierce", updatedAt: HOURS_AGO(1) })]);
  const inbox = arrange(items, { [key(11)]: { quadrant: "next", at: HOURS_AGO(6) } }, NOW, []);
  assert.deepEqual(inbox.next.map((i) => i.lead.number), [11]);
});
