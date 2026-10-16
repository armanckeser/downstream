// Which threads reach the PR author. A wrong "no" drops a finding you agreed
// with; a wrong "yes" publishes your private conversation with the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HeadMoved, publish, type Draft } from "./publish.ts";
import { goesOut } from "../domain/outgoing.ts";
import type { Note, ReviewState } from "../domain/model.ts";

function note(overrides: Partial<Note>): Note {
  return {
    id: "n_1",
    number: 1,
    kind: "finding",
    severity: "concern",
    category: "bug",
    title: "The paintball rules forget the last player",
    body: "",
    fix: "",
    impact: "",
    outgoing: null,
    symbolId: null,
    file: null,
    lines: null,
    side: "new",
    alternatives: [],
    suggestion: null,
    status: "open",
    author: "agent",
    createdAt: "2026-10-01T10:00:00Z",
    replies: [],
    ...overrides,
  };
}

const cases: [string, Partial<Note>, boolean][] = [
  // Regression guarded: "Send to author" settles the thread; a settled finding must still go out when you chose to send it.
  ["a finding you chose to send, now settled", { status: "resolved", outgoing: { include: true, body: "" } }, true],
  ["a finding you chose not to send", { status: "dismissed", outgoing: { include: false, body: "" } }, false],
  ["an unanswered finding", { status: "open" }, true],
  ["a finding settled without a choice", { status: "resolved" }, false],
  ["the agent's explanation, acknowledged", { kind: "why", status: "resolved", outgoing: { include: false, body: "" } }, false],
  ["the agent's decision you chose to send too", { kind: "decision", status: "resolved", outgoing: { include: true, body: "" } }, true],
  ["an open question to you", { kind: "question", status: "open" }, false],
];

for (const [name, overrides, expected] of cases) {
  test(`goesOut is ${expected} for ${name}`, () => assert.equal(goesOut(note(overrides)), expected));
}

// Sending onto a PR that moved on. The fake `gh` stands in at the process
// boundary: it answers `pr view` with the PR's current head and records any
// review it is asked to post, so nothing reaches GitHub.
const FAKE_GH = `#!/bin/sh
case "$1 $2" in
  "pr view") echo "$FAKE_HEAD" ;;
  "api -X") cat > "$FAKE_POSTED"; echo '{"html_url":"https://github.com/greendale/study-room/pull/7#pullrequestreview-1"}' ;;
esac
`;

function withFakeGh<T>(currentHead: string, run: (posted: string) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "downstream-gh-"));
  writeFileSync(path.join(dir, "gh"), FAKE_GH, { mode: 0o755 });
  const posted = path.join(dir, "posted.json");
  const saved = { PATH: process.env.PATH, FAKE_HEAD: process.env.FAKE_HEAD, FAKE_POSTED: process.env.FAKE_POSTED };
  Object.assign(process.env, { PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_HEAD: currentHead, FAKE_POSTED: posted });
  try {
    return run(posted);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
}

function prReview(head: string): ReviewState {
  return {
    review: {
      id: "r_1",
      title: "Paintball rules (#7)",
      mode: "diff",
      base: "origin/main",
      baseSha: "base",
      head,
      paths: [],
      pr: 7,
      repo: "greendale/study-room",
      account: null,
      summary: "",
      status: "ready",
      createdAt: "2026-10-01T10:00:00Z",
      verdicts: [],
      outgoingBody: "",
      published: null,
      posts: [],
    },
    files: [],
    symbols: [],
    edges: [],
    steps: [],
    notes: [],
    presence: { agent: "away", lastAgentActivity: null },
    cursor: 0,
    readThrough: null,
    visited: [],
  };
}

const DRAFT: Draft = { event: "COMMENT", body: "Looks good. Ship.", comments: [], target: { pr: 7, repo: "greendale/study-room" }, markdown: "" };

test("publish refuses and posts nothing when the PR head moved since the review was opened", () => {
  // Regression guarded: the author force-pushed mid-review and Send posted the
  // comments onto the replaced commit, where they showed as outdated.
  withFakeGh("pushedmidreview", (posted) => {
    assert.throws(() => publish(prReview("openedat"), DRAFT), (e) => e instanceof HeadMoved && e.current === "pushedmidreview");
    assert.equal(existsSync(posted), false);
  });
});

test("publish posts on the reviewed commit when the PR has not moved", () => {
  withFakeGh("openedat", (posted) => {
    const sent = publish(prReview("openedat"), DRAFT);
    assert.equal(sent.url, "https://github.com/greendale/study-room/pull/7#pullrequestreview-1");
    assert.equal((JSON.parse(readFileSync(posted, "utf8")) as { commit_id: string }).commit_id, "openedat");
  });
});

test("publish sends onto a moved head when forced", () => {
  withFakeGh("pushedmidreview", (posted) => {
    publish(prReview("openedat"), DRAFT, { force: true });
    assert.equal((JSON.parse(readFileSync(posted, "utf8")) as { commit_id: string }).commit_id, "openedat");
  });
});
