// The review screen's single primary action.
import { test } from "node:test";
import assert from "node:assert/strict";
import { nextMove } from "./next-move.ts";
import type { Note, Post, ReviewState, Step } from "./model.ts";

function state(overrides: { summary?: string; steps?: Step[]; notes?: Note[]; mode?: "diff" | "teach"; published?: boolean; posts?: Post[] }): ReviewState {
  return {
    review: {
      id: "rv_1",
      title: "Advanced Dungeons & Dragons",
      mode: overrides.mode ?? "diff",
      base: "main",
      baseSha: "abc",
      head: "def",
      paths: [],
      pr: 1,
      repo: "greendale/study-room",
      account: null,
      summary: overrides.summary ?? "",
      status: "drafting",
      createdAt: "2026-10-01T10:00:00Z",
      verdicts: [],
      outgoingBody: "",
      published: overrides.published ? { url: "https://github.com/greendale/pull/1#review", at: "2026-10-01T11:00:00Z", event: "COMMENT", comments: 2 } : null,
      posts: overrides.posts ?? [],
    },
    files: [],
    symbols: [],
    edges: [],
    steps: overrides.steps ?? [],
    notes: overrides.notes ?? [],
    presence: { agent: "listening", lastAgentActivity: null },
    cursor: 0,
    readThrough: null,
    visited: [],
  };
}

const step = (id: string, order: number): Step => ({ id, order, title: `Step ${order}`, body: "", symbolId: null, lines: null });

function note(overrides: Partial<Note>): Note {
  return {
    id: "n_1",
    number: 1,
    kind: "question",
    severity: null,
    category: null,
    title: "Is Neil the dungeon master?",
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

test("nextMove asks you to answer the agent before reading on", () => {
  // Regression guarded: an agent question sat unanswered while the screen kept
  // offering the next step, so the agent blocked in `downstream wait` forever.
  const move = nextMove(state({ summary: "x", steps: [step("s1", 1)], notes: [note({ number: 4, id: "n_4" })] }), new Set());
  assert.deepEqual(move, { kind: "answer", noteId: "n_4", number: 4 });
});

test("nextMove asks you to settle an open finding before sending", () => {
  // Regression guarded: with every step read, the button said Send review while a
  // finding the agent raised was still open, so it went out without your say.
  const move = nextMove(state({ summary: "x", notes: [note({ id: "n_3", number: 3, kind: "finding", severity: "nit" })] }), new Set());
  assert.deepEqual(move, { kind: "decide", noteId: "n_3", number: 3 });
});

test("nextMove walks the remaining steps before asking you to settle findings", () => {
  const move = nextMove(state({ summary: "x", steps: [step("s1", 1)], notes: [note({ kind: "finding", severity: "concern" })] }), new Set());
  assert.deepEqual(move, { kind: "walk", stepId: "s1", order: 1, total: 1 });
});


test("nextMove does not ask you to answer once you replied last", () => {
  const replied = note({ replies: [{ id: "r1", noteId: "n_1", author: "user", body: "Yes.", createdAt: "2026-10-01T10:05:00Z" }] });
  assert.deepEqual(nextMove(state({ summary: "x", notes: [replied] }), new Set()), { kind: "send" });
});

test("nextMove offers the first step you haven't opened", () => {
  const move = nextMove(state({ summary: "x", steps: [step("s1", 1), step("s2", 2), step("s3", 3)] }), new Set(["s1"]));
  assert.deepEqual(move, { kind: "walk", stepId: "s2", order: 2, total: 3 });
});

test("nextMove waits for the agent when it hasn't written anything yet", () => {
  assert.deepEqual(nextMove(state({}), new Set()), { kind: "reading" });
});

test("nextMove finishes a tour instead of sending it", () => {
  assert.deepEqual(nextMove(state({ summary: "x", mode: "teach", steps: [step("s1", 1)] }), new Set(["s1"])), { kind: "finish" });
});

test("nextMove reports a sent review even with threads still open", () => {
  const move = nextMove(state({ summary: "x", published: true, notes: [note({})] }), new Set());
  assert.deepEqual(move, { kind: "sent", url: "https://github.com/greendale/pull/1#review" });
});

const post = (posted: boolean): Post => ({
  id: "p_1",
  repo: "greendale/study-room",
  number: 9,
  body: "@abed can you add a dirty flag?",
  noteId: null,
  author: "agent",
  createdAt: "2026-10-01T10:30:00Z",
  posted: posted ? { url: "https://github.com/greendale/study-room/pull/9#issuecomment-1", at: "2026-10-01T11:30:00Z" } : null,
});

test("nextMove asks you to post a comment for another PR that's still unposted after the review went out", () => {
  // Regression guarded: the review was sent, the screen said "Back to inbox", and the
  // follow-up drafted for another PR was forgotten.
  const move = nextMove(state({ summary: "x", published: true, posts: [post(false)] }), new Set());
  assert.deepEqual(move, { kind: "post", count: 1 });
});

test("nextMove reports a sent review once every comment for other PRs is posted", () => {
  const move = nextMove(state({ summary: "x", published: true, posts: [post(true)] }), new Set());
  assert.deepEqual(move, { kind: "sent", url: "https://github.com/greendale/pull/1#review" });
});

const settled: [string, Partial<Note>][] = [
  ["a finding you settled", { kind: "finding", severity: "concern", status: "resolved" }],
  ["a finding you chose not to send", { kind: "finding", severity: "nit", status: "dismissed" }],
  ["your own flag, which waits on the agent", { kind: "question", author: "user" }],
];
for (const [name, overrides] of settled) {
  test(`nextMove offers send when the only thread left is ${name}`, () => {
    assert.deepEqual(nextMove(state({ summary: "x", notes: [note(overrides)] }), new Set()), { kind: "send" });
  });
}
