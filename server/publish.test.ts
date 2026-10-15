// Which threads reach the PR author. A wrong "no" drops a finding you agreed
// with; a wrong "yes" publishes your private conversation with the agent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { goesOut } from "./publish.ts";
import type { Note } from "../domain/model.ts";

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
