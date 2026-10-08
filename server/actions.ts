// Every way to change a review is an action defined once here. The browser,
// the agent's CLI and plain HTTP all call the same code, so the user can do
// anything the agent can and the other way round.
import { z } from "zod";
import {
  Alternative,
  Author,
  CodeSymbol,
  EdgeKind,
  NavigateCommand,
  Navigation,
  Note,
  NoteKind,
  NoteStatus,
  Range,
  Selection,
  Severity,
  Step,
  Suggestion,
  SymbolKind,
  SymbolStatus,
  type Edge,
  type Review,
} from "../domain/model.ts";
import { newId, now, type Store } from "./store.ts";
import { resolveTarget, Workspace } from "./workspace.ts";
import { tryGit } from "./analyze/git.ts";

export type ActionContext = {
  store: Store;
  actor: Author;
  root: string;
  workspace: (reviewId: string) => Workspace;
  dropWorkspace: (reviewId: string) => void;
};

type ActionDef<I extends z.ZodType, O> = {
  name: string;
  description: string;
  /** Read-only actions don't need a current review to exist or emit events. */
  readOnly?: boolean;
  input: I;
  run: (ctx: ActionContext & { reviewId: string }, input: z.infer<I>) => O | Promise<O>;
};

export const actions = new Map<string, ActionDef<z.ZodType, unknown>>();

function defineAction<I extends z.ZodType, O>(def: ActionDef<I, O>): ActionDef<I, O> {
  actions.set(def.name, def as unknown as ActionDef<z.ZodType, unknown>);
  return def;
}

export class ActionError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message);
  }
}

function requireSymbol(ctx: ActionContext & { reviewId: string }, id: string): CodeSymbol {
  const s = ctx.store.symbol(ctx.reviewId, id);
  if (s) return s;
  // Be forgiving with ids: accept a bare name if it is unique.
  const byName = ctx.store.symbols(ctx.reviewId).filter((x) => x.name === id || `${x.container}.${x.name}` === id || x.id.endsWith(`#${id}`));
  if (byName.length === 1) return byName[0]!;
  if (byName.length > 1) throw new ActionError(`"${id}" is ambiguous: ${byName.map((x) => x.id).join(", ")}`);
  throw new ActionError(`No symbol "${id}". Run \`downstream show\` for ids.`, 404);
}

function requireNote(ctx: ActionContext & { reviewId: string }, id: string): Note {
  const n = ctx.store.note(ctx.reviewId, id);
  if (!n) throw new ActionError(`No thread "${id}".`, 404);
  return n;
}

// --- review lifecycle ----------------------------------------------------------

export const openReview = defineAction({
  name: "review.open",
  description: "Analyze a change (or a set of paths, in teach mode) and open it as the current review.",
  input: z.object({
    mode: z.enum(["diff", "teach"]).default("diff"),
    base: z.string().optional(),
    head: z.string().optional(),
    pr: z.number().int().optional(),
    paths: z.array(z.string()).default([]),
    title: z.string().optional(),
  }),
  run(ctx, input) {
    const id = newId("rv");
    let review: Review;
    if (input.mode === "teach") {
      review = {
        id,
        title: input.title ?? `Tour of ${input.paths.join(", ") || "the repository"}`,
        mode: "teach",
        base: null,
        baseSha: null,
        head: "WORKTREE",
        paths: input.paths,
        pr: null,
        summary: "",
        status: "drafting",
        createdAt: now(),
        verdicts: [],
      };
    } else {
      const t = resolveTarget(ctx.root, input);
      review = {
        id,
        title: input.title ?? t.title ?? defaultTitle(ctx.root, t.head, t.base, input.pr),
        mode: "diff",
        base: t.base,
        baseSha: t.baseSha,
        head: t.head,
        paths: [],
        pr: input.pr ?? null,
        summary: "",
        status: "drafting",
        createdAt: now(),
        verdicts: [],
      };
    }
    ctx.store.saveReview(review, ctx.root);
    const { files, graph } = ctx.workspace(id).analyze();
    ctx.store.replaceAnalysis(id, files, graph.symbols, graph.edges);
    ctx.store.setCurrent(id);
    ctx.store.emit(id, "review.opened", ctx.actor, { id });
    return { review, files: files.length, symbols: graph.symbols.length, edges: graph.edges.length };
  },
});

defineAction({
  name: "review.reanalyze",
  description: "Re-read the code after it changed (e.g. a finding was fixed). Keeps summaries, threads and the walkthrough.",
  input: z.object({}),
  run(ctx) {
    ctx.dropWorkspace(ctx.reviewId);
    const { files, graph } = ctx.workspace(ctx.reviewId).analyze();
    ctx.store.replaceAnalysis(ctx.reviewId, files, graph.symbols, graph.edges);
    ctx.store.emit(ctx.reviewId, "review.reanalyzed", ctx.actor, { symbols: graph.symbols.length });
    return { symbols: graph.symbols.length, edges: graph.edges.length };
  },
});

defineAction({
  name: "review.update",
  description: "Set the title, the summary (markdown), or the status (drafting → ready when the walkthrough is written).",
  input: z.object({ title: z.string().optional(), summary: z.string().optional(), status: z.enum(["drafting", "ready", "done"]).optional() }),
  run(ctx, input) {
    const review = ctx.store.review(ctx.reviewId)!;
    const next = { ...review, ...Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) } as Review;
    ctx.store.saveReview(next);
    ctx.store.emit(ctx.reviewId, "review.updated", ctx.actor, input);
    return next;
  },
});

defineAction({
  name: "review.verdict",
  description: "Record a verdict: approve, changes (request changes), or comment.",
  input: z.object({ value: z.enum(["approve", "changes", "comment"]), body: z.string().default("") }),
  run(ctx, input) {
    const review = ctx.store.review(ctx.reviewId)!;
    const verdict = { by: ctx.actor, value: input.value, body: input.body, at: now() };
    const verdicts = [...review.verdicts.filter((v) => v.by !== ctx.actor), verdict];
    ctx.store.saveReview({ ...review, verdicts });
    ctx.store.emit(ctx.reviewId, "review.verdict", ctx.actor, verdict);
    return verdict;
  },
});

defineAction({
  name: "review.done",
  description: "End the session. A waiting agent is released with a `review.done` event.",
  input: z.object({}),
  run(ctx) {
    const review = ctx.store.review(ctx.reviewId)!;
    ctx.store.saveReview({ ...review, status: "done" });
    ctx.store.emit(ctx.reviewId, "review.done", ctx.actor, {});
    return { ok: true };
  },
});

// --- the map --------------------------------------------------------------------

const SymbolPatch = z.object({ id: z.string(), summary: z.string().nullable().optional(), entry: z.boolean().optional() });

defineAction({
  name: "symbol.annotate",
  description: "Give a symbol a one-line purpose, or mark/unmark it as an entry point.",
  input: SymbolPatch,
  run(ctx, input) {
    const s = requireSymbol(ctx, input.id);
    const next = { ...s, summary: input.summary !== undefined ? input.summary : s.summary, entry: input.entry ?? s.entry };
    ctx.store.putSymbol(ctx.reviewId, next);
    ctx.store.emit(ctx.reviewId, "symbol.annotated", ctx.actor, { id: s.id, entry: input.entry ?? null });
    return next;
  },
});

const NewSymbol = z.object({
  file: z.string(),
  name: z.string(),
  lines: Range.optional(),
  /** Alternatively point at one line and let the analyzer find the enclosing declaration (TS/JS). */
  line: z.number().int().optional(),
  kind: SymbolKind.default("function"),
  status: SymbolStatus.default("context"),
  summary: z.string().nullable().default(null),
  entry: z.boolean().default(false),
  signature: z.string().nullable().default(null),
});

defineAction({
  name: "symbol.add",
  description: "Put a symbol on the map by hand (other languages, or code the analyzer missed).",
  input: NewSymbol,
  run(ctx, input) {
    let s: CodeSymbol | null = null;
    if (!input.lines && input.line) s = ctx.workspace(ctx.reviewId).symbolAt(input.file, input.line);
    if (!s) {
      if (!input.lines) throw new ActionError("Give `lines: {start, end}` (or `line` inside a TS/JS declaration).");
      s = {
        id: `${input.file}#${input.name}`,
        name: input.name,
        container: null,
        kind: input.kind,
        file: input.file,
        range: input.lines,
        oldFile: null,
        oldRange: null,
        status: input.status,
        signature: input.signature,
        exported: false,
        entry: input.entry,
        summary: input.summary,
        changedLines: 0,
      };
    } else {
      s = { ...s, summary: input.summary, entry: input.entry, status: input.status };
    }
    ctx.store.putSymbol(ctx.reviewId, s, true);
    ctx.store.emit(ctx.reviewId, "symbol.added", ctx.actor, { id: s.id });
    return s;
  },
});

defineAction({
  name: "symbol.remove",
  description: "Take a symbol (and its edges) off the map.",
  input: z.object({ id: z.string() }),
  run(ctx, input) {
    const s = requireSymbol(ctx, input.id);
    ctx.store.deleteSymbol(ctx.reviewId, s.id);
    ctx.store.emit(ctx.reviewId, "symbol.removed", ctx.actor, { id: s.id });
    return { ok: true };
  },
});

const NewEdge = z.object({ from: z.string(), to: z.string(), kind: EdgeKind.default("calls"), label: z.string().nullable().default(null), change: z.enum(["added", "removed", "same"]).default("same") });

defineAction({
  name: "edge.add",
  description: "Draw a relationship the analyzer can't see (events, queues, HTTP between services, dynamic dispatch). Label it.",
  input: NewEdge,
  run(ctx, input) {
    const from = requireSymbol(ctx, input.from);
    const to = requireSymbol(ctx, input.to);
    const edge: Edge = { id: `${from.id}->${to.id}:${input.kind}`, from: from.id, to: to.id, kind: input.kind, change: input.change, line: null, label: input.label };
    ctx.store.putEdge(ctx.reviewId, edge, true);
    ctx.store.emit(ctx.reviewId, "edge.added", ctx.actor, { id: edge.id });
    return edge;
  },
});

defineAction({
  name: "edge.remove",
  description: "Remove a relationship that is noise.",
  input: z.object({ id: z.string() }),
  run(ctx, input) {
    ctx.store.deleteEdge(ctx.reviewId, input.id);
    ctx.store.emit(ctx.reviewId, "edge.removed", ctx.actor, input);
    return { ok: true };
  },
});

// --- walkthrough ---------------------------------------------------------------------

const StepInput = z.object({ title: z.string(), body: z.string().default(""), symbolId: z.string().nullable().default(null), lines: Range.nullable().default(null) });

function toSteps(ctx: ActionContext & { reviewId: string }, steps: z.infer<typeof StepInput>[]) {
  return steps.map(
    (s, i): Step => ({
      id: newId("st"),
      order: i + 1,
      title: s.title,
      body: s.body,
      symbolId: s.symbolId ? requireSymbol(ctx, s.symbolId).id : null,
      lines: s.lines,
    }),
  );
}

defineAction({
  name: "steps.set",
  description: "Replace the walkthrough: an ordered path through the change, entry point first, each step anchored to a symbol.",
  input: z.object({ steps: z.array(StepInput) }),
  run(ctx, input) {
    const steps = toSteps(ctx, input.steps);
    ctx.store.replaceSteps(ctx.reviewId, steps);
    ctx.store.emit(ctx.reviewId, "steps.set", ctx.actor, { count: steps.length });
    return steps;
  },
});

// --- threads ------------------------------------------------------------------------------

const NoteInput = z.object({
  kind: NoteKind,
  title: z.string(),
  body: z.string().default(""),
  severity: Severity.nullable().default(null),
  symbolId: z.string().nullable().default(null),
  file: z.string().nullable().default(null),
  lines: Range.nullable().default(null),
  side: z.enum(["new", "old"]).default("new"),
  alternatives: z.array(Alternative).default([]),
  suggestion: Suggestion.nullable().default(null),
});

function makeNote(ctx: ActionContext & { reviewId: string }, input: z.infer<typeof NoteInput>): Note {
  const symbol = input.symbolId ? requireSymbol(ctx, input.symbolId) : null;
  if (input.kind === "finding" && !input.severity) input.severity = "concern";
  return {
    id: newId("n"),
    kind: input.kind,
    severity: input.kind === "finding" ? input.severity : null,
    title: input.title,
    body: input.body,
    symbolId: symbol?.id ?? null,
    file: input.file ?? symbol?.file ?? null,
    lines: input.lines,
    side: input.side,
    alternatives: input.alternatives,
    suggestion: input.suggestion,
    status: "open",
    author: ctx.actor,
    createdAt: now(),
    replies: [],
  };
}

defineAction({
  name: "note.add",
  description:
    "Say something about the code. kind: why (rationale), decision (with alternatives that lost), finding (problem; severity blocker|concern|nit), question, comment. Anchor with symbolId and optional lines.",
  input: NoteInput,
  run(ctx, input) {
    const note = makeNote(ctx, input);
    ctx.store.putNote(ctx.reviewId, note);
    ctx.store.emit(ctx.reviewId, "note.added", ctx.actor, { id: note.id, kind: note.kind, title: note.title, symbolId: note.symbolId });
    return note;
  },
});

defineAction({
  name: "note.reply",
  description: "Reply in a thread.",
  input: z.object({ noteId: z.string(), body: z.string().min(1) }),
  run(ctx, input) {
    const note = requireNote(ctx, input.noteId);
    const reply = { id: newId("r"), noteId: note.id, author: ctx.actor, body: input.body, createdAt: now() };
    ctx.store.addReply(ctx.reviewId, reply);
    ctx.store.emit(ctx.reviewId, "note.replied", ctx.actor, { noteId: note.id, title: note.title, body: input.body, replyId: reply.id });
    return reply;
  },
});

defineAction({
  name: "note.status",
  description: "Resolve, dismiss, or reopen a thread.",
  input: z.object({ noteId: z.string(), status: NoteStatus, reason: z.string().optional() }),
  run(ctx, input) {
    const note = requireNote(ctx, input.noteId);
    ctx.store.putNote(ctx.reviewId, { ...note, status: input.status });
    if (input.reason) {
      ctx.store.addReply(ctx.reviewId, { id: newId("r"), noteId: note.id, author: ctx.actor, body: input.reason, createdAt: now() });
    }
    ctx.store.emit(ctx.reviewId, "note.status", ctx.actor, { noteId: note.id, title: note.title, status: input.status, reason: input.reason ?? null });
    return { ok: true };
  },
});

defineAction({
  name: "ask",
  description: "Ask the other side a question about a symbol or a line range. Opens a question thread.",
  input: z.object({ body: z.string().min(1), symbolId: z.string().nullable().default(null), file: z.string().nullable().default(null), lines: Range.nullable().default(null), side: z.enum(["new", "old"]).default("new") }),
  run(ctx, input) {
    const title = input.body.split("\n")[0]!.slice(0, 120);
    const note = makeNote(ctx, { kind: "question", title, body: input.body.length > title.length ? input.body : "", severity: null, symbolId: input.symbolId, file: input.file, lines: input.lines, side: input.side, alternatives: [], suggestion: null });
    ctx.store.putNote(ctx.reviewId, note);
    ctx.store.emit(ctx.reviewId, "ask", ctx.actor, { id: note.id, body: input.body, symbolId: note.symbolId, file: note.file, lines: note.lines });
    return note;
  },
});

// --- batch authoring -------------------------------------------------------------------------

defineAction({
  name: "apply",
  description: "Author the whole walkthrough in one call: summary, symbol purposes and entry flags, extra symbols and edges, steps, notes.",
  input: z.object({
    title: z.string().optional(),
    summary: z.string().optional(),
    status: z.enum(["drafting", "ready"]).optional(),
    symbols: z.array(SymbolPatch).default([]),
    addSymbols: z.array(NewSymbol).default([]),
    edges: z.array(NewEdge).default([]),
    removeEdges: z.array(z.string()).default([]),
    steps: z.array(StepInput).optional(),
    notes: z.array(NoteInput).default([]),
  }),
  async run(ctx, input) {
    const results: string[] = [];
    const call = async (name: string, payload: unknown) => {
      const def = actions.get(name)!;
      return def.run(ctx, def.input.parse(payload));
    };
    if (input.title || input.summary || input.status) {
      await call("review.update", { title: input.title, summary: input.summary, status: input.status });
      results.push("review updated");
    }
    for (const s of input.addSymbols) await call("symbol.add", s);
    if (input.addSymbols.length) results.push(`${input.addSymbols.length} symbols added`);
    for (const s of input.symbols) await call("symbol.annotate", s);
    if (input.symbols.length) results.push(`${input.symbols.length} symbols annotated`);
    for (const e of input.edges) await call("edge.add", e);
    for (const id of input.removeEdges) await call("edge.remove", { id });
    if (input.steps) {
      await call("steps.set", { steps: input.steps });
      results.push(`${input.steps.length} steps`);
    }
    for (const n of input.notes) await call("note.add", n);
    if (input.notes.length) results.push(`${input.notes.length} notes`);
    return { ok: true, applied: results };
  },
});

// --- shared application state ----------------------------------------------------------------

defineAction({
  name: "state.set",
  description: "The UI reports what the user is looking at (navigation) and what they selected (selection).",
  input: z.discriminatedUnion("key", [z.object({ key: z.literal("navigation"), value: Navigation }), z.object({ key: z.literal("selection"), value: Selection.nullable() })]),
  run(ctx, input) {
    ctx.store.setAppState(ctx.reviewId, input.key, input.value);
    return { ok: true };
  },
});

defineAction({
  name: "navigate",
  description: "Move the user's view: open a symbol (optionally highlighting lines), a step, a thread, or switch view.",
  input: NavigateCommand,
  run(ctx, input) {
    if (input.symbolId) input.symbolId = requireSymbol(ctx, input.symbolId).id;
    const cmd = { ...input, nonce: newId("nav") };
    ctx.store.emit(ctx.reviewId, "navigate", ctx.actor, cmd);
    return cmd;
  },
});

defineAction({
  name: "screen",
  readOnly: true,
  description: "What the user is looking at right now: their view, the trail of open symbols, and their selected code.",
  input: z.object({}),
  run(ctx) {
    const nav = ctx.store.getAppState<Navigation>(ctx.reviewId, "navigation");
    const sel = ctx.store.getAppState<Selection>(ctx.reviewId, "selection");
    const ws = ctx.workspace(ctx.reviewId);
    let selectedCode: string | null = null;
    if (sel) {
      const text = ws.read(sel.file, sel.side);
      selectedCode = text?.split("\n").slice(sel.lines.start - 1, sel.lines.end).join("\n") ?? null;
    }
    const symbols = new Map(ctx.store.symbols(ctx.reviewId).map((s) => [s.id, s]));
    return {
      view: nav?.view ?? "overview",
      trail: (nav?.trail ?? []).map((id) => {
        const s = symbols.get(id);
        return s ? { id, name: s.name, file: s.file, lines: s.range } : { id };
      }),
      step: nav?.stepId ? (ctx.store.steps(ctx.reviewId).find((s) => s.id === nav.stepId) ?? null) : null,
      thread: nav?.noteId ? ctx.store.note(ctx.reviewId, nav.noteId) : null,
      selection: sel ? { ...sel, code: selectedCode } : null,
      presence: ctx.store.presence(),
    };
  },
});

function defaultTitle(root: string, head: string, base: string, pr?: number): string {
  if (pr) return `PR #${pr}`;
  if (head !== "WORKTREE") return tryGit(root, ["log", "-1", "--format=%s", head])?.trim() || `${head} against ${base}`;
  const branch = tryGit(root, ["branch", "--show-current"])?.trim();
  return branch && branch !== "main" && branch !== "master" ? `${branch}, uncommitted` : "Uncommitted work";
}
