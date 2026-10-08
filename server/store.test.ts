// What the agent has read, against a real SQLite file.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { Store } from "./store.ts";
import type { ReviewEvent } from "../domain/model.ts";

function tempDb() {
  const dir = mkdtempSync(path.join(tmpdir(), "ds-store-"));
  return { file: path.join(dir, "review.db"), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("readThrough is null when the agent has never been handed anything", () => {
  const db = tempDb();
  try {
    const store = new Store(db.file);
    store.emit("rv_1", "ask", "user", { body: "why?" });
    store.markRead("rv_1", []);
    assert.equal(store.readThrough("rv_1"), null);
  } finally {
    db.cleanup();
  }
});

test("readThrough is the newest event handed over, so a message sent after it stays unread", () => {
  // Regression guarded: the margin said nothing about whether `downstream wait`
  // had delivered a message, so a sent question looked identical whether the
  // agent was answering it or no agent was running at all.
  const db = tempDb();
  try {
    const store = new Store(db.file);
    const handed: ReviewEvent[] = [
      { id: 2, type: "note.replied", actor: "user", payload: {}, at: "2026-10-08T10:00:05.000Z" },
      { id: 3, type: "ask", actor: "user", payload: {}, at: "2026-10-08T10:00:09.000Z" },
      { id: 1, type: "ask", actor: "user", payload: {}, at: "2026-10-08T10:00:01.000Z" },
    ];
    store.markRead("rv_1", handed);
    assert.equal(store.readThrough("rv_1"), "2026-10-08T10:00:09.000Z");
    assert.equal(store.readThrough("rv_other"), null);
  } finally {
    db.cleanup();
  }
});

test("readThrough survives a server restart on the same database", () => {
  const db = tempDb();
  try {
    const before = new Store(db.file);
    const ask = before.emit("rv_1", "ask", "user", { body: "why?" });
    before.markRead("rv_1", [ask]);
    before.db.close();
    assert.equal(new Store(db.file).readThrough("rv_1"), ask.at);
  } finally {
    db.cleanup();
  }
});

test("marking a read is a system event, so it never wakes a waiting agent", () => {
  const db = tempDb();
  try {
    const store = new Store(db.file);
    const ask = store.emit("rv_1", "ask", "user", { body: "why?" });
    store.markRead("rv_1", [ask]);
    assert.deepEqual(
      store.events("rv_1", ask.id, "user").map((e) => e.type),
      [],
    );
  } finally {
    db.cleanup();
  }
});

test("the agent counts as working after being handed a message, even by a wait that returned at once", () => {
  // Regression guarded: a `downstream wait` that found a message already pending never
  // joined as a waiter, so an agent idle for 90s stayed "away" and the thread said stalled.
  const db = tempDb();
  try {
    const store = new Store(db.file);
    assert.equal(store.presence().agent, "away");
    const ask = store.emit("rv_1", "ask", "user", { body: "why?" });
    store.markRead("rv_1", [ask]);
    assert.equal(store.presence().agent, "working");
  } finally {
    db.cleanup();
  }
});
