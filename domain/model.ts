// The review model. Shared by the server, the CLI and the browser so the three
// never disagree about what a symbol, a flow edge or a thread is.
import { z } from "zod";

export const Range = z.object({ start: z.number().int().min(1), end: z.number().int().min(1) });
export type Range = z.infer<typeof Range>;

/** What happened to a symbol in this change. `context` = unchanged, shown so the flow reads end to end. */
export const SymbolStatus = z.enum(["added", "modified", "removed", "context"]);
export type SymbolStatus = z.infer<typeof SymbolStatus>;

export const SymbolKind = z.enum([
  "function",
  "method",
  "class",
  "interface",
  "type",
  "route",
  "component",
  "const",
  "module",
]);
export type SymbolKind = z.infer<typeof SymbolKind>;

export const CodeSymbol = z.object({
  /** Stable id: `<file>#<Container.name>`. */
  id: z.string(),
  name: z.string(),
  container: z.string().nullable().default(null),
  kind: SymbolKind,
  file: z.string(),
  /** Lines on the new side. Null for removed symbols. */
  range: Range.nullable(),
  oldFile: z.string().nullable().default(null),
  oldRange: Range.nullable().default(null),
  status: SymbolStatus,
  signature: z.string().nullable().default(null),
  exported: z.boolean().default(false),
  /** A door into the change: nothing else in the change calls it. */
  entry: z.boolean().default(false),
  /** Lives in a test file: shown as "tested by", never a door. */
  test: z.boolean().default(false),
  /** The agent's one-line answer to "what is this for?". */
  summary: z.string().nullable().default(null),
  /** Changed lines inside the symbol, new side. */
  changedLines: z.number().int().default(0),
});
export type CodeSymbol = z.infer<typeof CodeSymbol>;

export const EdgeKind = z.enum(["calls", "renders", "implements", "extends", "uses"]);
export type EdgeKind = z.infer<typeof EdgeKind>;

/** Whether the relationship itself is new in this change. */
export const EdgeChange = z.enum(["added", "removed", "same"]);
export type EdgeChange = z.infer<typeof EdgeChange>;

export const Edge = z.object({
  id: z.string(),
  from: z.string(),
  to: z.string(),
  kind: EdgeKind,
  change: EdgeChange.default("same"),
  /** Call site line in `from`'s file (new side, or old side for removed edges). */
  line: z.number().int().nullable().default(null),
  label: z.string().nullable().default(null),
});
export type Edge = z.infer<typeof Edge>;

export const Step = z.object({
  id: z.string(),
  order: z.number().int(),
  title: z.string(),
  body: z.string().default(""),
  symbolId: z.string().nullable().default(null),
  lines: Range.nullable().default(null),
});
export type Step = z.infer<typeof Step>;

/**
 * Everything said about the code is a thread.
 * - why: rationale for something that looks odd
 * - decision: a design choice with the alternatives that lost
 * - finding: a problem the reviewer wants addressed
 * - question: someone needs an answer from the other side
 * - comment: anything else
 */
export const NoteKind = z.enum(["why", "decision", "finding", "question", "comment"]);
export type NoteKind = z.infer<typeof NoteKind>;

/** Shown as must fix / should fix / nice to have. */
export const Severity = z.enum(["blocker", "concern", "nit"]);
export type Severity = z.infer<typeof Severity>;
export const severityLabel: Record<Severity, string> = { blocker: "must fix", concern: "should fix", nit: "nice to have" };

/** What kind of problem a finding is, in the order a reviewer who gets paged cares about. */
export const FindingCategory = z.enum(["bug", "risk", "scale", "test", "speed", "lean"]);
export type FindingCategory = z.infer<typeof FindingCategory>;

/** The comment this thread becomes on the pull request, if it goes out at all. */
export const Outgoing = z.object({ include: z.boolean(), body: z.string() });
export type Outgoing = z.infer<typeof Outgoing>;

export const NoteStatus = z.enum(["open", "resolved", "dismissed"]);
export type NoteStatus = z.infer<typeof NoteStatus>;

export const Author = z.enum(["agent", "user"]);
export type Author = z.infer<typeof Author>;

export const Alternative = z.object({ option: z.string(), tradeoff: z.string() });
export type Alternative = z.infer<typeof Alternative>;

export const Suggestion = z.object({ code: z.string(), lines: Range });
export type Suggestion = z.infer<typeof Suggestion>;

export const Reply = z.object({
  id: z.string(),
  noteId: z.string(),
  author: Author,
  body: z.string(),
  createdAt: z.string(),
});
export type Reply = z.infer<typeof Reply>;

export const Note = z.object({
  id: z.string(),
  /** Short handle for conversation: "fix 2 and 5". */
  number: z.number().int().default(0),
  kind: NoteKind,
  severity: Severity.nullable().default(null),
  category: FindingCategory.nullable().default(null),
  title: z.string(),
  /** For findings: the problem, with the concrete case that goes wrong. */
  body: z.string().default(""),
  /** For findings: the smallest fix. */
  fix: z.string().default(""),
  /** For findings: what happens if we ship it anyway. */
  impact: z.string().default(""),
  outgoing: Outgoing.nullable().default(null),
  symbolId: z.string().nullable().default(null),
  file: z.string().nullable().default(null),
  lines: Range.nullable().default(null),
  side: z.enum(["new", "old"]).default("new"),
  alternatives: z.array(Alternative).default([]),
  suggestion: Suggestion.nullable().default(null),
  status: NoteStatus.default("open"),
  author: Author,
  createdAt: z.string(),
  replies: z.array(Reply).default([]),
});
export type Note = z.infer<typeof Note>;

export const FileChange = z.object({
  path: z.string(),
  oldPath: z.string().nullable(),
  status: z.enum(["added", "modified", "deleted", "renamed", "context"]),
  additions: z.number().int(),
  deletions: z.number().int(),
});
export type FileChange = z.infer<typeof FileChange>;

export const Verdict = z.object({
  by: Author,
  value: z.enum(["approve", "changes", "comment"]),
  body: z.string().default(""),
  at: z.string(),
});
export type Verdict = z.infer<typeof Verdict>;

export const Review = z.object({
  id: z.string(),
  title: z.string(),
  mode: z.enum(["diff", "teach"]),
  /** What the user asked to compare against (a branch name, a PR base). */
  base: z.string().nullable(),
  /** The merge base actually diffed against. */
  baseSha: z.string().nullable().default(null),
  /** A ref, or WORKTREE for uncommitted work. */
  head: z.string(),
  /** Teach mode: the paths being explained. */
  paths: z.array(z.string()).default([]),
  pr: z.number().int().nullable().default(null),
  summary: z.string().default(""),
  status: z.enum(["drafting", "ready", "done"]),
  createdAt: z.string(),
  verdicts: z.array(Verdict).default([]),
  /** The body of the review that goes to the pull request; the agent drafts it, the user edits it. */
  outgoingBody: z.string().default(""),
  published: z.object({ url: z.string(), at: z.string(), event: z.string(), comments: z.number().int() }).nullable().default(null),
});
export type Review = z.infer<typeof Review>;

/** The whole artifact, as the browser and `downstream show --json` see it. */
export type ReviewState = {
  review: Review;
  files: FileChange[];
  symbols: CodeSymbol[];
  edges: Edge[];
  steps: Step[];
  notes: Note[];
  presence: Presence;
  cursor: number;
  /** The newest user message `downstream wait` has handed to the agent; anything at or before it, the agent has read. */
  readThrough: string | null;
};

/** Is the agent in the room? `listening` = a `downstream wait` is blocked on the user. */
export type Presence = {
  agent: "listening" | "working" | "away";
  lastAgentActivity: string | null;
};

// ---------------------------------------------------------------------------
// Application state: the UI tells the agent what the user sees; the agent can
// move the user's view. Same idea as agent-native's navigation/selection keys.
// ---------------------------------------------------------------------------

export const Navigation = z.object({
  view: z.enum(["overview", "trail", "map"]),
  trail: z.array(z.string()).default([]),
  stepId: z.string().nullable().default(null),
  noteId: z.string().nullable().default(null),
});
export type Navigation = z.infer<typeof Navigation>;

export const Selection = z.object({
  symbolId: z.string().nullable(),
  file: z.string(),
  lines: Range,
  side: z.enum(["new", "old"]).default("new"),
});
export type Selection = z.infer<typeof Selection>;

export const NavigateCommand = z.object({
  symbolId: z.string().nullable().default(null),
  stepId: z.string().nullable().default(null),
  noteId: z.string().nullable().default(null),
  view: z.enum(["overview", "trail", "map"]).nullable().default(null),
  lines: Range.nullable().default(null),
  nonce: z.string().optional(),
});
export type NavigateCommand = z.infer<typeof NavigateCommand>;

export type ReviewEvent = {
  id: number;
  type: string;
  actor: Author | "system";
  payload: unknown;
  at: string;
};
