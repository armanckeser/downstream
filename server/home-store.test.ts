// Where you put PRs survives upgrades. A lost choice brings back everything you
// set aside; a table that rejects a placement breaks the button that writes it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { HomeStore } from "./home-store.ts";

function withDbFile(run: (file: string) => void) {
  const dir = mkdtempSync(path.join(tmpdir(), "downstream-home-"));
  try {
    run(path.join(dir, "home.db"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("HomeStore keeps your choices and accepts hidden when opening a database made before hidden existed", () => {
  // Regression guarded: "Hide until someone pushes or comments" failed with
  // "CHECK constraint failed" on every database created before the sweep.
  withDbFile((file) => {
    const old = new DatabaseSync(file);
    old.exec("CREATE TABLE triage (account TEXT NOT NULL, item_key TEXT NOT NULL, quadrant TEXT NOT NULL CHECK (quadrant IN ('do', 'next', 'delegate', 'someday')), at TEXT NOT NULL, PRIMARY KEY (account, item_key))");
    old.exec("INSERT INTO triage VALUES ('jeff', 'greendale/study-room#1', 'someday', '2026-10-01T10:00:00Z')");
    old.close();

    const store = new HomeStore(file);
    store.choose("jeff", "greendale/study-room#2", "hidden");
    const choices = store.choices("jeff");
    assert.deepEqual(choices["greendale/study-room#1"], { quadrant: "someday", at: "2026-10-01T10:00:00Z" });
    assert.equal(choices["greendale/study-room#2"]?.quadrant, "hidden");
  });
});

test("HomeStore still rejects a placement that doesn't exist", () => {
  withDbFile((file) => {
    const store = new HomeStore(file);
    assert.throws(() => store.db.exec("INSERT INTO triage VALUES ('jeff', 'greendale/study-room#3', 'paintball', '2026-10-01T10:00:00Z')"), /CHECK constraint failed/);
  });
});
