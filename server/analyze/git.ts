// Git plumbing: which files changed, which lines changed, and file contents on
// either side. "head" is either a ref or the working tree (uncommitted work
// counts, untracked files included) so an agent can review what it just wrote.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import type { FileChange, Range } from "../../domain/model.ts";

export const WORKTREE = "WORKTREE";

export function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });
}

export function tryGit(cwd: string, args: string[]): string | null {
  try {
    return git(cwd, args);
  } catch {
    return null;
  }
}

export function repoRoot(cwd: string): string {
  return git(cwd, ["rev-parse", "--show-toplevel"]).trim();
}

/** Reads files from one side of the change. */
export interface FileSource {
  readonly label: string;
  read(file: string): string | null;
  exists(file: string): boolean;
}

export function worktreeSource(root: string): FileSource {
  return {
    label: WORKTREE,
    read(file) {
      const abs = path.join(root, file);
      return existsSync(abs) ? readFileSync(abs, "utf8") : null;
    },
    exists: (file) => existsSync(path.join(root, file)),
  };
}

export function refSource(root: string, ref: string): FileSource {
  const cache = new Map<string, string | null>();
  let listing: Set<string> | null = null;
  const files = () => (listing ??= new Set(git(root, ["ls-tree", "-r", "--name-only", ref]).split("\n").filter(Boolean)));
  return {
    label: ref,
    read(file) {
      if (!cache.has(file)) cache.set(file, files().has(file) ? tryGit(root, ["show", `${ref}:${file}`]) : null);
      return cache.get(file) ?? null;
    },
    exists: (file) => files().has(file),
  };
}

export type Hunks = { added: Range[]; deleted: Range[] };

export type DiffInfo = {
  mergeBase: string;
  files: FileChange[];
  hunks: Map<string, Hunks>;
};

function parseHunks(patch: string): Hunks {
  const added: Range[] = [];
  const deleted: Range[] = [];
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const oldStart = Number(m[1]);
    const oldLen = m[2] === undefined ? 1 : Number(m[2]);
    const newStart = Number(m[3]);
    const newLen = m[4] === undefined ? 1 : Number(m[4]);
    if (oldLen > 0) deleted.push({ start: oldStart, end: oldStart + oldLen - 1 });
    if (newLen > 0) added.push({ start: newStart, end: newStart + newLen - 1 });
  }
  return { added, deleted };
}

const IGNORED = /(^|\/)(package-lock\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|\.downstream\/)/;

export function diff(root: string, base: string, head: string): DiffInfo {
  const headRef = head === WORKTREE ? "HEAD" : head;
  const mergeBase = (tryGit(root, ["merge-base", base, headRef]) ?? git(root, ["rev-parse", base])).trim();
  const range = head === WORKTREE ? [mergeBase] : [mergeBase, head];

  const files: FileChange[] = [];
  const hunks = new Map<string, Hunks>();

  const numstat = git(root, ["diff", "--numstat", "-M", ...range]);
  const nameStatus = git(root, ["diff", "--name-status", "-M", ...range]);
  const counts = new Map<string, [number, number]>();
  for (const line of numstat.split("\n").filter(Boolean)) {
    const [a, d, ...rest] = line.split("\t");
    const p = rest.at(-1)!;
    counts.set(p, [Number(a) || 0, Number(d) || 0]);
  }
  for (const line of nameStatus.split("\n").filter(Boolean)) {
    const parts = line.split("\t");
    const code = parts[0]![0];
    const p = parts.at(-1)!;
    if (IGNORED.test(p)) continue;
    const oldPath = code === "R" ? parts[1]! : code === "A" ? null : p;
    const status = code === "A" ? "added" : code === "D" ? "deleted" : code === "R" ? "renamed" : "modified";
    const [additions, deletions] = counts.get(p) ?? counts.get(`${parts[1]} => ${p}`) ?? [0, 0];
    files.push({ path: p, oldPath, status, additions, deletions });
    const patch = git(root, ["diff", "-U0", "-M", ...range, "--", ...(oldPath && oldPath !== p ? [oldPath, p] : [p])]);
    hunks.set(p, parseHunks(patch));
  }

  if (head === WORKTREE) {
    const untracked = git(root, ["ls-files", "--others", "--exclude-standard"]).split("\n").filter(Boolean);
    for (const p of untracked) {
      if (IGNORED.test(p) || files.some((f) => f.path === p)) continue;
      const text = tryReadText(path.join(root, p));
      if (text === null) continue;
      const lines = text.split("\n").length;
      files.push({ path: p, oldPath: null, status: "added", additions: lines, deletions: 0 });
      hunks.set(p, { added: [{ start: 1, end: lines }], deleted: [] });
    }
  }

  return { mergeBase, files, hunks };
}

function tryReadText(abs: string): string | null {
  try {
    const buf = readFileSync(abs);
    if (buf.length > 2_000_000 || buf.includes(0)) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

export function inRanges(line: number, ranges: Range[]): boolean {
  return ranges.some((r) => line >= r.start && line <= r.end);
}

export function countInRange(range: Range, ranges: Range[]): number {
  let n = 0;
  for (const r of ranges) {
    const s = Math.max(r.start, range.start);
    const e = Math.min(r.end, range.end);
    if (e >= s) n += e - s + 1;
  }
  return n;
}
