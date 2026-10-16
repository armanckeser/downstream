// What leaves Downstream, through the same actions the browser and the agent
// call, against a real SQLite file. A wrong answer here either drops a comment
// you meant to send or publishes something you meant to keep.
import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "./store.ts";
import { actions, type ActionContext } from "./actions.ts";
import type { Note, Post, Review } from "../domain/model.ts";

const REVIEW: Review = {
  id: "rv_1",
  title: "Paintball rules (#7)",
  mode: "diff",
  base: "origin/main",
  baseSha: "base",
  head: "head",
  paths: [],
  pr: 7,
  repo: "greendale/study-room",
  account: null,
  summary: "",
  status: "ready",
  createdAt: "2026-10-01T10:00:00Z",
  verdicts: [],
  outgoingBody: "Thanks, Troy.",
  published: null,
  posts: [],
};

const FINDING: Note = {
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
};

function withReview<T>(notes: Note[], run: (act: (name: string, input: unknown) => unknown, store: Store) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "ds-outgoing-"));
  try {
    const store = new Store(path.join(dir, "review.db"));
    store.saveReview(REVIEW, dir);
    for (const n of notes) store.putNote(REVIEW.id, n);
    const ctx: ActionContext & { reviewId: string } = {
      store,
      actor: "user",
      root: dir,
      nameWithOwner: "greendale/study-room",
      accountFor: () => null,
      workspace: () => {
        throw new Error("no workspace in this test");
      },
      dropWorkspace: () => {},
      reviewId: REVIEW.id,
    };
    const act = (name: string, input: unknown) => {
      const def = actions.get(name)!;
      return def.run(ctx, def.input.parse(input));
    };
    return run(act, store);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const ON_A_LINE: Note = { ...FINDING, file: "rules.py", lines: { start: 3, end: 3 } };

type DraftOut = { body: string; comments: { noteId: string; inline: boolean }[] };

test("settling an open finding keeps it in the review when nobody chose to drop it", () => {
  // Regression guarded: open findings go out by default, so "Settle" (status → resolved)
  // silently took an agreed finding out of the review you were about to send.
  withReview([ON_A_LINE], (act) => {
    act("note.status", { noteId: "n_1", status: "resolved" });
    const draft = act("review.draft", {}) as DraftOut;
    assert.deepEqual(draft.comments.map((c) => c.noteId), ["n_1"]);
  });
});

test("dismissing an open finding takes it out of the review", () => {
  withReview([ON_A_LINE], (act) => {
    act("note.status", { noteId: "n_1", status: "dismissed" });
    const draft = act("review.draft", {}) as DraftOut;
    assert.deepEqual(draft.comments, []);
  });
});

test("a thread on the whole change that goes out lands in the review body when it has no line", () => {
  // Regression guarded: draft() skipped any outgoing thread without a file and line,
  // so a general comment you chose to send never reached the author.
  const general = { ...FINDING, outgoing: { include: true, body: "Could the rules name a winner when it's a tie?" } };
  withReview([general], (act) => {
    const draft = act("review.draft", {}) as DraftOut;
    assert.equal(draft.body, "Thanks, Troy.\n\nCould the rules name a winner when it's a tie?");
    assert.deepEqual(draft.comments.map((c) => c.inline), [false]);
  });
});

test("a private thread stays out of the review body when it has no line", () => {
  const general = { ...FINDING, outgoing: { include: false, body: "Between us: Pierce wrote this." } };
  withReview([general], (act) => {
    const draft = act("review.draft", {}) as DraftOut;
    assert.equal(draft.body, "Thanks, Troy.");
  });
});

// The fake `gh` stands in at the process boundary: it records where a comment
// was posted and what it said, and answers with the comment's URL.
const FAKE_GH = `#!/bin/sh
echo "$4" > "$FAKE_ENDPOINT"
cat > "$FAKE_POSTED"
echo '{"html_url":"https://github.com/greendale/study-room/pull/9#issuecomment-1"}'
`;

function withFakeGh<T>(run: (record: { endpoint: string; posted: string }) => T): T {
  const dir = mkdtempSync(path.join(tmpdir(), "ds-gh-"));
  writeFileSync(path.join(dir, "gh"), FAKE_GH, { mode: 0o755 });
  const record = { endpoint: path.join(dir, "endpoint"), posted: path.join(dir, "posted.json") };
  const saved = { PATH: process.env.PATH, FAKE_ENDPOINT: process.env.FAKE_ENDPOINT, FAKE_POSTED: process.env.FAKE_POSTED };
  Object.assign(process.env, { PATH: `${dir}${path.delimiter}${process.env.PATH}`, FAKE_ENDPOINT: record.endpoint, FAKE_POSTED: record.posted });
  try {
    return run(record);
  } finally {
    for (const [k, v] of Object.entries(saved)) v === undefined ? delete process.env[k] : (process.env[k] = v);
    rmSync(dir, { recursive: true, force: true });
  }
}

test("a comment drafted for another PR is posted on that PR, not in this review", () => {
  // Regression guarded: a follow-up meant for the PR that caused a bug had nowhere to
  // live, so it sat in a reply as "say post it" and was never sent.
  withFakeGh((record) =>
    withReview([], (act, store) => {
      const post = act("post.draft", { number: 9, body: "@abed can you add a dirty flag?" }) as Post;
      assert.equal(existsSync(record.posted), false);
      act("post.send", { postId: post.id });
      assert.equal(readFileSync(record.endpoint, "utf8").trim(), "repos/greendale/study-room/issues/9/comments");
      assert.deepEqual(JSON.parse(readFileSync(record.posted, "utf8")), { body: "@abed can you add a dirty flag?" });
      assert.equal(store.review(REVIEW.id)!.posts[0]!.posted?.url, "https://github.com/greendale/study-room/pull/9#issuecomment-1");
      assert.equal((act("review.draft", {}) as DraftOut).body, "Thanks, Troy.");
    }),
  );
});

test("posting a comment that was discarded is refused", () => {
  withFakeGh((record) =>
    withReview([], (act) => {
      const post = act("post.draft", { number: 9, body: "Never mind." }) as Post;
      act("post.discard", { postId: post.id });
      assert.throws(() => act("post.send", { postId: post.id }), /No drafted comment/);
      assert.equal(existsSync(record.posted), false);
    }),
  );
});
