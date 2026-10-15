// What the preview shows before you decide to start: what the PR says it does,
// how big it is, and where its checks and reviews stand.

export type Person = { login: string; name: string | null; avatar: string | null };

export type ReviewState = "approved" | "changes_requested" | "commented" | "dismissed";

export type Requested = ({ kind: "person" } & Person) | { kind: "team"; name: string };

export type FileChange = { path: string; additions: number; deletions: number; change: "added" | "deleted" | "modified" | "renamed" | "copied" | "changed" };

export type PrDetail = {
  body: string;
  createdAt: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  commits: number;
  /** Up to the first 100, in GitHub's order; `reviewable` sorts out what matters. */
  files: FileChange[];
  reviews: (Person & { state: ReviewState })[];
  requested: Requested[];
  /** Check names by outcome; cancelled and skipped runs count as neither. */
  checks: { passing: number; failing: string[]; pending: string[] };
};

/**
 * What a changed file is to a reviewer. `code` is what changes behavior and
 * deserves attention; `test` is evidence about it; `docs` explains it;
 * `generated` (lockfiles, snapshots, build output) nobody reads line by line.
 */
export type FileRole = "code" | "test" | "docs" | "generated";

const GENERATED: RegExp[] = [
  /(^|\/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|bun\.lockb?|uv\.lock|poetry\.lock|Pipfile\.lock|pdm\.lock|Cargo\.lock|go\.sum|Gemfile\.lock|composer\.lock|flake\.lock|mix\.lock|pubspec\.lock|Podfile\.lock|packages\.lock\.json)$/,
  /\.(min\.(js|css)|map|snap)$/,
  /(^|\/)(__snapshots__|dist|build|vendor|node_modules|\.yarn)\//,
  /(_pb2(_grpc)?\.pyi?|\.pb\.go|\.pb\.(cc|h)|\.g\.dart|\.generated\.[a-z]+)$/,
];
const TEST: RegExp[] = [
  /(^|\/)(tests?|__tests__|spec|testdata|fixtures|__fixtures__|__mocks__)\//,
  /\.(test|spec)\.[cm]?[jt]sx?$/,
  /(^|\/)(test_[^/]+|[^/]+_test)\.py$/,
  /(^|\/)conftest\.py$/,
  /_test\.go$/,
  /Tests?\.(cs|java|kt|swift)$/,
];
const DOCS: RegExp[] = [/\.(md|mdx|rst|txt|adoc)$/i, /(^|\/)docs?\//, /(^|\/)(LICENSE|CHANGELOG|AUTHORS)[^/]*$/i];

export function fileRole(path: string): FileRole {
  if (GENERATED.some((r) => r.test(path))) return "generated";
  if (TEST.some((r) => r.test(path))) return "test";
  if (DOCS.some((r) => r.test(path))) return "docs";
  return "code";
}

export type Reviewable = {
  /** Code files, most changed first: what the preview lists. */
  code: FileChange[];
  /** How many of each other kind, for the one-line summary. */
  others: Record<Exclude<FileRole, "code">, number>;
  /** Lines a reviewer reads: code, tests and docs, never generated files. */
  additions: number;
  deletions: number;
};

export function reviewable(files: FileChange[]): Reviewable {
  const others = { test: 0, docs: 0, generated: 0 };
  const code: FileChange[] = [];
  let additions = 0;
  let deletions = 0;
  for (const f of files) {
    const role = fileRole(f.path);
    if (role !== "generated") {
      additions += f.additions;
      deletions += f.deletions;
    }
    if (role === "code") code.push(f);
    else others[role]++;
  }
  code.sort((a, b) => b.additions + b.deletions - (a.additions + a.deletions));
  return { code, others, additions, deletions };
}
