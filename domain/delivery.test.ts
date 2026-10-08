// Where a thread stands with the agent: the line the margin shows under your last message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { delivery, type Delivery } from "./delivery.ts";
import { Note, type Presence } from "./model.ts";

const ASKED = "2026-10-08T10:00:00.000Z";
const BEFORE = "2026-10-08T09:59:00.000Z";
const AFTER = "2026-10-08T10:00:30.000Z";

const presence = (agent: Presence["agent"]): Presence => ({ agent, lastAgentActivity: null });

const question = (over: Partial<Note> = {}) =>
  Note.parse({ id: "n_troy", kind: "question", title: "Why is Abed's cache keyed by week?", author: "user", createdAt: ASKED, ...over });

const reply = (author: "user" | "agent", createdAt: string) => ({ id: `r_${author}_${createdAt}`, noteId: "n_troy", author, body: "Cool cool cool.", createdAt });

// Regression guarded: a sent question looked the same whether an agent was
// answering it, had never seen it, or had read it and died.
const cases: { name: string; note: Note; readThrough: string | null; agent: Presence["agent"]; expected: Delivery | null }[] = [
  { name: "unread when the agent has never been handed anything", note: question(), readThrough: null, agent: "listening", expected: "unread" },
  { name: "unread when the agent's last read predates the question", note: question(), readThrough: BEFORE, agent: "working", expected: "unread" },
  { name: "answering when read and the agent is busy", note: question(), readThrough: AFTER, agent: "working", expected: "answering" },
  { name: "answering when read through exactly the question's timestamp", note: question(), readThrough: ASKED, agent: "working", expected: "answering" },
  { name: "read when the agent went back to listening without replying", note: question(), readThrough: AFTER, agent: "listening", expected: "read" },
  { name: "stalled when read and the agent went quiet", note: question(), readThrough: AFTER, agent: "away", expected: "stalled" },
  { name: "read, not stalled, for a plain note the agent needn't answer", note: question({ kind: "comment" }), readThrough: AFTER, agent: "away", expected: "read" },
  { name: "read, not answering, for a flag while the agent is busy", note: question({ kind: "finding", severity: "concern" }), readThrough: AFTER, agent: "working", expected: "read" },
  {
    name: "unread when the user's newest reply came after the last read",
    note: question({ kind: "finding", author: "agent", replies: [reply("user", "2026-10-08T10:01:00.000Z")] }),
    readThrough: AFTER,
    agent: "listening",
    expected: "unread",
  },
  { name: "nothing when the agent spoke last", note: question({ replies: [reply("agent", AFTER)] }), readThrough: null, agent: "away", expected: null },
  { name: "nothing when the thread is resolved", note: question({ status: "resolved" }), readThrough: null, agent: "away", expected: null },
];

for (const c of cases) {
  test(`delivery is ${c.expected ?? "null"} ${c.name}`, () => {
    assert.equal(delivery(c.note, c.readThrough, presence(c.agent)), c.expected);
  });
}
