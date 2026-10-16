// When a review on the home page is the last round, and when it's still the one to resume.
import { test } from "node:test";
import assert from "node:assert/strict";
import { lastRound } from "./home.ts";
import type { Move } from "./inbox.ts";

const SENT = { at: "2026-10-01T09:00:00Z" };
const ASKED_AGAIN: Move = { kind: "rereview", because: { how: "re-requested", at: "2026-10-02T09:00:00Z" } };

test("lastRound is true when the author asked again after you sent the review", () => {
  // Regression guarded: Annie re-requested, Re-review opened the sent review, and its only button went back to the inbox.
  assert.equal(lastRound(SENT, ASKED_AGAIN), true);
});

test("lastRound is false when the review was sent after the hand-back", () => {
  assert.equal(lastRound({ at: "2026-10-03T09:00:00Z" }, ASKED_AGAIN), false);
});

test("lastRound is false when the review was never sent", () => {
  assert.equal(lastRound(null, ASKED_AGAIN), false);
});

test("lastRound is false when the PR is waiting on the author", () => {
  assert.equal(lastRound(SENT, { kind: "waiting", on: "author" }), false);
});
