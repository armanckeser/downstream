// What the preview lists as a PR's biggest changes. A wrong "code" puts a
// lockfile above the change that matters; a wrong "generated" hides real code.
import { test } from "node:test";
import assert from "node:assert/strict";
import { fileRole, reviewable, type FileChange, type FileRole } from "./pr-detail.ts";

const roles: [string, FileRole][] = [
  ["uv.lock", "generated"],
  ["frontend/package-lock.json", "generated"],
  ["go.sum", "generated"],
  ["web/src/__snapshots__/Study.test.tsx.snap", "generated"],
  ["dist/app.min.js", "generated"],
  ["api/study_pb2.py", "generated"],
  ["tests/test_paintball.py", "test"],
  ["src/paintball/test_rules.py", "test"],
  ["src/rules_test.go", "test"],
  ["web/src/rules.test.ts", "test"],
  ["projects/corsa/tests/agent/abilities/workspace.py", "test"],
  ["conftest.py", "test"],
  ["README.md", "docs"],
  ["docs/architecture.png", "docs"],
  ["src/paintball/rules.py", "code"],
  ["server/alembic/versions/0042_add_flag.py", "code"],
  // Regression guarded: "latest" contains "test"; a loose match would hide this file as a test.
  ["src/latest_scores.py", "code"],
  ["src/contest/bracket.ts", "code"],
  ["src/build_info.py", "code"],
];

for (const [path, role] of roles) {
  test(`fileRole calls ${path} ${role}`, () => assert.equal(fileRole(path), role));
}

const file = (path: string, additions: number, deletions = 0): FileChange => ({ path, additions, deletions, change: "modified" });

test("reviewable lists code most-changed first and counts the rest", () => {
  // Regression guarded: the preview's biggest change was uv.lock (2,000 lines) above a 40-line code change.
  const result = reviewable([file("uv.lock", 2000, 1500), file("src/a.py", 10), file("tests/test_a.py", 90), file("src/b.py", 30, 10), file("README.md", 5)]);
  assert.deepEqual(result.code.map((f) => f.path), ["src/b.py", "src/a.py"]);
  assert.deepEqual(result.others, { test: 1, docs: 1, generated: 1 });
});

test("reviewable leaves generated lines out of the size", () => {
  const result = reviewable([file("uv.lock", 2000, 1500), file("src/a.py", 10, 2), file("tests/test_a.py", 90)]);
  assert.equal(result.additions, 100);
  assert.equal(result.deletions, 2);
});

test("reviewable returns no code when a PR only bumps dependencies", () => {
  const result = reviewable([file("uv.lock", 300, 280), file("pyproject.toml", 1, 1)]);
  assert.deepEqual(result.code.map((f) => f.path), ["pyproject.toml"]);
  assert.equal(result.others.generated, 1);
});
