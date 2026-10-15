// What each stale-PR decision does on GitHub and here. A wrong write posts to
// someone else's PR; a hide after a refused write loses the PR silently.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { toItems, type PrFacts } from "../domain/inbox.ts";
import { decide, GitHubRefused, NotOffered } from "./stale.ts";

// Stands in for gh at the process boundary: logs each call's arguments, one per
// line, and fails when FAKE_GH_FAIL is set, as gh does when GitHub refuses.
const FAKE_GH = `#!/bin/sh
printf '%s\\n' "$*" >> "$FAKE_GH_LOG"
if [ -n "$FAKE_GH_FAIL" ]; then echo "HTTP 403: Must have admin rights" >&2; exit 1; fi
echo '{}'
`;

async function withFakeGh(fail: boolean, run: (calls: () => string[]) => Promise<void>) {
  const dir = mkdtempSync(path.join(tmpdir(), "downstream-gh-"));
  writeFileSync(path.join(dir, "gh"), FAKE_GH, { mode: 0o755 });
  const log = path.join(dir, "calls.log");
  const saved = { PATH: process.env.PATH, FAKE_GH_LOG: process.env.FAKE_GH_LOG, FAKE_GH_FAIL: process.env.FAKE_GH_FAIL };
  Object.assign(process.env, { PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_GH_LOG: log, FAKE_GH_FAIL: fail ? "1" : "" });
  try {
    // gh's own token lookup for the account isn't a write; leave it out.
    await run(() => (existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").filter((c) => !c.startsWith("auth token")) : []));
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
}

function stalePr(overrides: Partial<PrFacts>): PrFacts {
  return {
    repo: "greendale/study-room",
    number: 30,
    title: "Paintball rules",
    url: "https://github.com/greendale/study-room/pull/30",
    author: "annie",
    authorKind: "person",
    authorName: null,
    authorAvatar: null,
    isDraft: false,
    updatedAt: "2026-01-01T10:00:00Z",
    baseRef: "main",
    headRef: "paintball",
    headSha: "aaa",
    reviewDecision: null,
    checks: "passing",
    mergeable: "mergeable",
    unresolvedThreads: 0,
    role: "reviewer",
    reviewRequested: true,
    myReviewAt: null,
    authorSince: null,
    stack: null,
    touched: null,
    ...overrides,
  };
}

const [requested] = toItems([stalePr({})]);
const [yours] = toItems([stalePr({ role: "author", author: "jeff" })]);

test("decide removes only your own review request, then hides the PR", async () => {
  await withFakeGh(false, async (calls) => {
    let hidden = 0;
    await decide("jeff", requested!, { kind: "remove-request" }, () => hidden++);
    assert.deepEqual(calls(), ["api -X DELETE repos/greendale/study-room/pulls/30/requested_reviewers -f reviewers[]=jeff"]);
    assert.equal(hidden, 1);
  });
});

test("decide keeps the PR visible when GitHub refuses to remove the request", async () => {
  // Regression guarded: a refused write still hid the PR, so it vanished with the request still standing.
  await withFakeGh(true, async () => {
    let hidden = 0;
    await assert.rejects(decide("jeff", requested!, { kind: "remove-request" }, () => hidden++), GitHubRefused);
    assert.equal(hidden, 0);
  });
});

test("decide posts the comment you wrote on the PR's conversation, then hides it", async () => {
  await withFakeGh(false, async (calls) => {
    let hidden = 0;
    await decide("jeff", requested!, { kind: "comment", body: "@annie is this still going?" }, () => hidden++);
    assert.deepEqual(calls(), ["api -X POST repos/greendale/study-room/issues/30/comments -f body=@annie is this still going?"]);
    assert.equal(hidden, 1);
  });
});

test("decide closes your own PR with your reason and leaves hiding to GitHub", async () => {
  await withFakeGh(false, async (calls) => {
    let hidden = 0;
    await decide("jeff", yours!, { kind: "close", reason: "Superseded by #31" }, () => hidden++);
    assert.deepEqual(calls(), ["pr close 30 --repo greendale/study-room --comment Superseded by #31"]);
    assert.equal(hidden, 0);
  });
});

test("decide refuses to close someone else's PR without calling GitHub", async () => {
  await withFakeGh(false, async (calls) => {
    await assert.rejects(decide("jeff", requested!, { kind: "close", reason: "Nope" }, () => {}), NotOffered);
    assert.deepEqual(calls(), []);
  });
});

test("decide hides without calling GitHub", async () => {
  await withFakeGh(false, async (calls) => {
    let hidden = 0;
    await decide("jeff", requested!, { kind: "hide" }, () => hidden++);
    assert.deepEqual([calls(), hidden], [[], 1]);
  });
});
