// The analyzer against a real (throwaway) git repository.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { diff, refSource, worktreeSource } from "./git.ts";
import { buildGraph } from "./graph.ts";
import { Workspace } from "../workspace.ts";
import type { Review } from "../../domain/model.ts";

function repo(files: Record<string, string>) {
  const root = mkdtempSync(path.join(tmpdir(), "ds-test-"));
  const run = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  run("init", "-q", "-b", "main");
  run("config", "user.email", "t@example.com");
  run("config", "user.name", "t");
  const write = (fs: Record<string, string>) => {
    for (const [p, text] of Object.entries(fs)) {
      mkdirSync(path.dirname(path.join(root, p)), { recursive: true });
      writeFileSync(path.join(root, p), text);
    }
  };
  write(files);
  run("add", "-A");
  run("commit", "-qm", "base");
  return { root, write, cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

const BASE = {
  "tsconfig.json": JSON.stringify({ compilerOptions: { strict: true, module: "esnext", moduleResolution: "bundler", allowImportingTsExtensions: true, noEmit: true }, include: ["src"] }),
  "src/store.ts": `export function save(x: number) {\n  return x;\n}\n\nexport function audit(x: number) {\n  return x;\n}\n`,
  "src/api.ts": `import { save, audit } from "./store.ts";\n\nexport function handle(n: number) {\n  audit(n);\n  return save(n);\n}\n`,
  "src/main.ts": `import { handle } from "./api.ts";\n\nexport function main() {\n  return handle(1);\n}\n`,
};

test("maps a change: statuses, new and removed calls, callers, doors", () => {
  const r = repo(BASE);
  try {
    r.write({
      "src/store.ts": `export function save(x: number) {\n  return validate(x);\n}\n\n/** Rejects negatives. */\nexport function validate(x: number) {\n  if (x < 0) throw new Error("negative");\n  return x;\n}\n`,
      "src/api.ts": `import { save } from "./store.ts";\n\nexport function handle(n: number) {\n  return save(n);\n}\n`,
    });
    const d = diff(r.root, "HEAD", "WORKTREE");
    const g = buildGraph({ root: r.root, mode: "diff", files: d.files, hunks: d.hunks, oldSrc: refSource(r.root, d.mergeBase), newSrc: worktreeSource(r.root) });
    const by = new Map(g.symbols.map((s) => [s.id, s]));

    assert.equal(by.get("src/store.ts#validate")?.status, "added");
    assert.equal(by.get("src/store.ts#save")?.status, "modified");
    assert.equal(by.get("src/store.ts#audit")?.status, "removed");
    assert.equal(by.get("src/api.ts#handle")?.status, "modified");
    // JSDoc belongs to the declaration.
    assert.deepEqual(by.get("src/store.ts#validate")?.range, { start: 5, end: 9 });

    const edge = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);
    assert.equal(edge("src/store.ts#save", "src/store.ts#validate")?.change, "added");
    assert.equal(edge("src/api.ts#handle", "src/store.ts#audit")?.change, "removed");
    // The unchanged caller is found and shown as context.
    assert.equal(by.get("src/main.ts#main")?.status, "context");
    assert.ok(edge("src/main.ts#main", "src/api.ts#handle"));

    // handle is the door: nothing else in the change calls it.
    assert.equal(by.get("src/api.ts#handle")?.entry, true);
    assert.equal(by.get("src/store.ts#validate")?.entry, false);
  } finally {
    r.cleanup();
  }
});

test("frames carry real line numbers and hover reads types", () => {
  const r = repo(BASE);
  try {
    r.write({ "src/store.ts": BASE["src/store.ts"].replace("return x;\n}\n\nexport function audit", "const y = x * 2;\n  return y;\n}\n\nexport function audit") });
    const review: Review = {
      id: "rv_t",
      title: "t",
      mode: "diff",
      base: "HEAD",
      baseSha: execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.root, encoding: "utf8" }).trim(),
      head: "WORKTREE",
      paths: [],
      pr: null,
      summary: "",
      status: "drafting",
      createdAt: new Date().toISOString(),
      verdicts: [],
      outgoingBody: "",
      published: null,
    };
    const ws = new Workspace(r.root, review);
    const { graph } = ws.analyze();
    const save = graph.symbols.find((s) => s.id === "src/store.ts#save")!;
    const frame = ws.frame(save)!;
    assert.match(frame.patch, /^@@ -1,3 \+1,4 @@$/m);
    assert.match(frame.patch, /^\+  const y = x \* 2;$/m);

    const hover = ws.hover("src/api.ts", 5, 9, "new");
    assert.match(hover?.display ?? "", /save\(x: number\): number/);
  } finally {
    r.cleanup();
  }
});

test("teach mode maps existing code without a diff", () => {
  const r = repo(BASE);
  try {
    const g = buildGraph({
      root: r.root,
      mode: "teach",
      files: Object.keys(BASE)
        .filter((p) => p.endsWith(".ts"))
        .map((p) => ({ path: p, oldPath: null, status: "context" as const, additions: 0, deletions: 0 })),
      hunks: new Map(),
      oldSrc: null,
      newSrc: worktreeSource(r.root),
    });
    assert.ok(g.symbols.every((s) => s.status === "context"));
    assert.ok(g.edges.some((e) => e.from === "src/api.ts#handle" && e.to === "src/store.ts#save"));
    assert.deepEqual(
      g.symbols.filter((s) => s.entry).map((s) => s.id),
      ["src/main.ts#main"],
    );
  } finally {
    r.cleanup();
  }
});

const PY_BASE = {
  "app/__init__.py": "",
  "app/service.py": `class GrantService:\n    """Writes grants."""\n\n    def create(self, qty):\n        return self.audit(qty)\n\n    def audit(self, qty):\n        return qty\n`,
  "app/api.py": `from fastapi import APIRouter\nfrom .service import GrantService\n\nrouter = APIRouter()\nsvc = GrantService()\n\n\n@router.post("/grants")\ndef create_grant(body: dict):\n    return svc.create(body["qty"])\n`,
  "app/jobs.py": `from app.service import GrantService\n\n\ndef nightly():\n    GrantService().create(1)\n`,
};

test("python: statuses, routes as doors, calls through imports and self, callers", () => {
  const r = repo(PY_BASE);
  try {
    r.write({
      "app/service.py": `class GrantService:\n    """Writes grants."""\n\n    def create(self, qty):\n        \"\"\"Validate, then store.\"\"\"\n        return self.validate(qty)\n\n    def validate(self, qty):\n        if qty < 0:\n            raise ValueError("negative")\n        return qty\n`,
    });
    const d = diff(r.root, "HEAD", "WORKTREE");
    const g = buildGraph({ root: r.root, mode: "diff", files: d.files, hunks: d.hunks, oldSrc: refSource(r.root, d.mergeBase), newSrc: worktreeSource(r.root) });
    const by = new Map(g.symbols.map((s) => [s.id, s]));
    assert.equal(by.get("app/service.py#GrantService.create")?.status, "modified");
    assert.equal(by.get("app/service.py#GrantService.validate")?.status, "added");
    assert.equal(by.get("app/service.py#GrantService.audit")?.status, "removed");

    const edge = (from: string, to: string) => g.edges.find((e) => e.from === from && e.to === to);
    assert.equal(edge("app/service.py#GrantService.create", "app/service.py#GrantService.validate")?.change, "added");
    assert.equal(edge("app/service.py#GrantService.create", "app/service.py#GrantService.audit")?.change, "removed");
    // Callers through a module-level instance and through `from app.service import ...`.
    assert.ok(edge("app/api.py#create_grant", "app/service.py#GrantService.create"), "route calls create");
    assert.ok(edge("app/jobs.py#nightly", "app/service.py#GrantService.create"), "job calls create");
    assert.equal(by.get("app/api.py#create_grant")?.kind, "route");
  } finally {
    r.cleanup();
  }
});

test("python hover reads signatures and docstrings through imports", () => {
  const r = repo(PY_BASE);
  try {
    const review: Review = {
      id: "rv_py", title: "t", mode: "teach", base: null, baseSha: null, head: "WORKTREE", paths: ["app"], pr: null,
      summary: "", status: "drafting", createdAt: new Date().toISOString(), verdicts: [], outgoingBody: "", published: null,
    };
    const ws = new Workspace(r.root, review);
    const { graph } = ws.analyze();
    assert.ok(graph.symbols.some((s) => s.id === "app/api.py#create_grant" && s.entry));
    // `svc.create(...)` on line 10 of api.py, cursor on "create".
    const h = ws.hover("app/api.py", 10, 15, "new");
    assert.match(h?.display ?? "", /def create\(self, qty\)/);
    const cls = ws.hover("app/jobs.py", 5, 6, "new");
    assert.match(cls?.docs ?? cls?.display ?? "", /Writes grants|class GrantService|def /);
  } finally {
    r.cleanup();
  }
});
