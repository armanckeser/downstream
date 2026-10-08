// One review's view of the repository: both sides of the change, the flow
// graph analysis, symbol frames for the UI, and IDE-grade hover.
import ts from "typescript";
import { execFileSync } from "node:child_process";
import { structuredPatch } from "diff";
import type { CodeSymbol, Range, Review } from "../domain/model.ts";
import { diff, git, refSource, WORKTREE, worktreeSource, type FileSource, type Hunks } from "./analyze/git.ts";
import { buildGraph, isTestFile, type Graph } from "./analyze/graph.ts";
import { isTsLike } from "./analyze/ts-decls.ts";
import { clearFsCache, TsProjects } from "./analyze/ts-project.ts";
import { isPy, PyIndex } from "./analyze/py.ts";
import type { FileChange } from "../domain/model.ts";

export type Frame = {
  symbolId: string;
  file: string;
  /** A unified patch scoped to the symbol, hunk header carrying real line numbers. */
  patch: string;
  added: number;
  deleted: number;
};

export type Hover = {
  /** Display string, e.g. `function createReview(input: CreateInput): Review`. */
  display: string;
  docs: string;
  tags: { name: string; text: string }[];
  kind: string;
};

export type Definition = { file: string; line: number; symbolId: string | null };

export class Workspace {
  readonly newSrc: FileSource;
  readonly oldSrc: FileSource | null;
  private newProjects: TsProjects | null = null;
  private pyNew: PyIndex | null = null;
  private pyOld: PyIndex | null = null;
  private oldProjects: TsProjects | null = null;
  private hunks = new Map<string, Hunks>();
  private files: FileChange[] = [];

  constructor(
    readonly root: string,
    readonly review: Review,
  ) {
    this.newSrc = review.head === WORKTREE ? worktreeSource(root) : refSource(root, review.head);
    this.oldSrc = review.baseSha ? refSource(root, review.baseSha) : null;
  }

  analyze(): { files: FileChange[]; graph: Graph } {
    clearFsCache();
    if (this.review.mode === "diff") {
      const d = diff(this.root, this.review.baseSha ?? this.review.base ?? "HEAD", this.review.head);
      this.files = d.files;
      this.hunks = d.hunks;
    } else {
      const listed = git(this.root, ["ls-files", "--", ...(this.review.paths.length ? this.review.paths : ["."])])
        .split("\n")
        .filter((f) => f && !/(^|\/)(node_modules|dist|build)\//.test(f) && /\.(m|c)?(t|j)sx?$|\.(py|go|rs|rb|java|kt|swift|sql)$/.test(f))
        .slice(0, 400);
      this.files = listed.map((p) => ({ path: p, oldPath: null, status: "context" as const, additions: 0, deletions: 0 }));
      this.hunks = new Map();
    }
    // The analyzer's parsed programs become the hover service, so the first hover is instant.
    this.newProjects = new TsProjects(this.root, this.newSrc, this.files.filter((f) => f.status !== "deleted").map((f) => f.path));
    this.oldProjects = null;
    this.pyNew = null;
    this.pyOld = null;
    const graph = buildGraph({ root: this.root, mode: this.review.mode, files: this.files, hunks: this.hunks, oldSrc: this.oldSrc, newSrc: this.newSrc, projects: this.newProjects, pyIndex: this.py("new") ?? undefined });
    return { files: this.files, graph };
  }

  private projects(side: "new" | "old"): TsProjects | null {
    if (side === "new") {
      return (this.newProjects ??= new TsProjects(this.root, this.newSrc, this.files.filter((f) => f.status !== "deleted").map((f) => f.path)));
    }
    if (!this.oldSrc) return null;
    return (this.oldProjects ??= new TsProjects(this.root, this.oldSrc, this.files.filter((f) => f.oldPath).map((f) => f.oldPath!)));
  }

  read(file: string, side: "new" | "old"): string | null {
    return side === "new" ? this.newSrc.read(file) : (this.oldSrc?.read(file) ?? null);
  }

  /** The symbol as a patch: old slice vs new slice, numbered as in the real files. */
  frame(s: CodeSymbol): Frame | null {
    const slice = (text: string | null, r: Range | null) => (text && r ? text.split("\n").slice(r.start - 1, r.end) : null);
    const newLines = slice(this.read(s.file, "new"), s.range);
    const oldLines = s.status === "context" ? null : slice(this.read(s.oldFile ?? s.file, "old"), s.oldRange);
    if (!newLines && !oldLines) return null;

    const header = [`diff --git a/${s.oldFile ?? s.file} b/${s.file}`, `--- a/${s.oldFile ?? s.file}`, `+++ b/${s.file}`];
    let body: string[];
    let added = 0;
    let deleted = 0;

    if (newLines && oldLines) {
      const p = structuredPatch("a", "b", oldLines.join("\n") + "\n", newLines.join("\n") + "\n", "", "", { context: 1e6 });
      const h = p.hunks[0];
      if (!h) {
        body = [`@@ -${s.oldRange!.start},${oldLines.length} +${s.range!.start},${newLines.length} @@`, ...newLines.map((l) => " " + l)];
      } else {
        const lines = h.lines.filter((l) => !l.startsWith("\\"));
        added = lines.filter((l) => l.startsWith("+")).length;
        deleted = lines.filter((l) => l.startsWith("-")).length;
        body = [`@@ -${h.oldStart + s.oldRange!.start - 1},${h.oldLines} +${h.newStart + s.range!.start - 1},${h.newLines} @@`, ...lines];
      }
    } else if (newLines) {
      const allAdded = s.status === "added";
      const prefix = allAdded ? "+" : " ";
      if (allAdded) added = newLines.length;
      const oldStart = allAdded ? 0 : s.range!.start;
      body = [`@@ -${oldStart},${allAdded ? 0 : newLines.length} +${s.range!.start},${newLines.length} @@`, ...newLines.map((l) => prefix + l)];
    } else {
      deleted = oldLines!.length;
      body = [`@@ -${s.oldRange!.start},${oldLines!.length} +0,0 @@`, ...oldLines!.map((l) => "-" + l)];
    }
    return { symbolId: s.id, file: s.file, patch: [...header, ...body].join("\n") + "\n", added, deleted };
  }

  private py(side: "new" | "old"): PyIndex | null {
    if (side === "new") return (this.pyNew ??= new PyIndex(this.newSrc.files(), (f) => this.newSrc.read(f)));
    const old = this.oldSrc;
    if (!old) return null;
    return (this.pyOld ??= new PyIndex(old.files(), (f) => old.read(f)));
  }

  /** Python: what the name under the cursor refers to, through the file's imports. */
  private pyTarget(file: string, line: number, col: number, side: "new" | "old") {
    const index = this.py(side);
    const chain = index?.chainAt(file, line, col);
    if (!index || !chain) return null;
    const pf = index.get(file);
    const own = pf?.decls.find((d) => d.defLine === line && d.name === chain.split(".").at(-1));
    if (own) return { file, decl: own };
    return index.resolve(file, chain, line);
  }

  hover(file: string, line: number, col: number, side: "new" | "old"): Hover | null {
    if (isPy(file)) {
      const hit = this.pyTarget(file, line, col, side);
      if (!hit) return null;
      return { display: hit.decl.signature, docs: hit.decl.doc, tags: [], kind: hit.decl.kind };
    }
    const project = this.projects(side)?.for(file);
    const pos = project?.position(file, line, col);
    if (!project || pos == null) return null;
    let info: ts.QuickInfo | undefined;
    try {
      info = project.service.getQuickInfoAtPosition(project.abs(file), pos);
    } catch {
      return null;
    }
    if (!info) return null;
    return {
      display: ts.displayPartsToString(info.displayParts),
      docs: ts.displayPartsToString(info.documentation),
      tags: (info.tags ?? []).map((t) => ({ name: t.name, text: ts.displayPartsToString(t.text) })),
      kind: info.kind,
    };
  }

  definition(file: string, line: number, col: number, side: "new" | "old", symbols: CodeSymbol[]): Definition | null {
    if (isPy(file)) {
      const hit = this.pyTarget(file, line, col, side);
      if (!hit) return null;
      const sid = `${hit.file}#${hit.decl.key}`;
      return { file: hit.file, line: hit.decl.defLine, symbolId: symbols.some((s) => s.id === sid) ? sid : null };
    }
    if (!isTsLike(file)) return null;
    const project = this.projects(side)?.for(file);
    const pos = project?.position(file, line, col);
    if (!project || pos == null) return null;
    let defs: readonly ts.DefinitionInfo[] | undefined;
    try {
      defs = project.service.getDefinitionAtPosition(project.abs(file), pos);
    } catch {
      return null;
    }
    const def = defs?.[0];
    if (!def) return null;
    const rel = project.rel(def.fileName);
    if (rel === null) return null;
    const sf = project.program().getSourceFile(def.fileName);
    const defLine = sf ? sf.getLineAndCharacterOfPosition(def.textSpan.start).line + 1 : 1;
    const hit = symbols
      .filter((s) => s.file === rel && s.range && defLine >= s.range.start && defLine <= s.range.end)
      .sort((a, b) => a.range!.end - a.range!.start - (b.range!.end - b.range!.start))[0];
    return { file: rel, line: defLine, symbolId: hit?.id ?? null };
  }

  /** Find the declaration around a line, for "add this to the map". */
  symbolAt(file: string, line: number): CodeSymbol | null {
    if (isPy(file)) {
      const pf = this.py("new")?.get(file);
      const d = pf?.decls.filter((x) => line >= x.range.start && line <= x.range.end).sort((a, b) => a.range.end - a.range.start - (b.range.end - b.range.start))[0];
      if (!d) return null;
      return { id: `${file}#${d.key}`, name: d.name, container: d.container, kind: d.kind, file, range: d.range, oldFile: null, oldRange: null, status: "context", signature: d.signature, exported: d.exported, entry: false, summary: null, changedLines: 0, test: isTestFile(file) };
    }
    const project = this.projects("new")?.for(file);
    const entry = project?.declsFor(file);
    if (!entry) return null;
    const hit = entry.decls
      .filter((d) => line >= d.range.start && line <= d.range.end)
      .sort((a, b) => a.range.end - a.range.start - (b.range.end - b.range.start))[0];
    if (!hit) return null;
    return {
      id: `${file}#${hit.key}`,
      name: hit.name,
      container: hit.container,
      kind: hit.kind,
      file,
      range: hit.range,
      oldFile: null,
      oldRange: null,
      status: "context",
      signature: hit.signature,
      exported: hit.exported,
      entry: false,
      summary: null,
      changedLines: 0,
      test: isTestFile(file),
    };
  }
}

/** Resolve what to compare. `--pr` asks gh for the base branch and fetches the head. */
export function resolveTarget(root: string, opts: { base?: string; head?: string; pr?: number }): { base: string; baseSha: string; head: string; title?: string } {
  if (opts.pr) {
    const info = JSON.parse(
      execGh(root, ["pr", "view", String(opts.pr), "--json", "baseRefName,headRefOid,title"]),
    ) as { baseRefName: string; headRefOid: string; title: string };
    git(root, ["fetch", "--quiet", "origin", info.baseRefName, `pull/${opts.pr}/head`]);
    const head = info.headRefOid;
    const baseSha = git(root, ["merge-base", `origin/${info.baseRefName}`, head]).trim();
    return { base: `origin/${info.baseRefName}`, baseSha, head, title: `${info.title} (#${opts.pr})` };
  }
  const head = opts.head ?? WORKTREE;
  const base = opts.base ?? defaultBase(root);
  const headRef = head === WORKTREE ? "HEAD" : head;
  const baseSha = git(root, ["merge-base", base, headRef]).trim();
  return { base, baseSha, head };
}

function defaultBase(root: string): string {
  for (const cand of ["origin/main", "origin/master", "main", "master"]) {
    try {
      git(root, ["rev-parse", "--verify", "--quiet", cand]);
      const mb = git(root, ["merge-base", cand, "HEAD"]).trim();
      const headSha = git(root, ["rev-parse", "HEAD"]).trim();
      // On the default branch itself: review uncommitted work against HEAD.
      if (mb === headSha) return "HEAD";
      return cand;
    } catch {
      /* try next */
    }
  }
  return "HEAD";
}

function execGh(cwd: string, args: string[]): string {
  return execFileSync("gh", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
}
