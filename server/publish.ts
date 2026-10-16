// Turning the review you and the agent arrived at into what the PR author sees.
// The conversation stays private; only threads marked to go out are sent, in
// the words drafted for the author, after the user presses Send.
import type { Post, Review, ReviewState } from "../domain/model.ts";
import { commentBody, goesOut } from "../domain/outgoing.ts";
import { git } from "./analyze/git.ts";
import { gh } from "./gh.ts";

export type DraftComment = {
  noteId: string;
  number: number;
  /** Null for a comment on the whole change; it goes into the review body. */
  path: string | null;
  line: number;
  startLine: number | null;
  side: "RIGHT" | "LEFT";
  body: string;
  /** GitHub only accepts inline comments on lines in (or near) the diff. Others go into the body. */
  inline: boolean;
};

export type Draft = {
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
  body: string;
  comments: DraftComment[];
  target: { pr: number; repo: string | null } | null;
  markdown: string;
};


function diffLines(root: string, review: Review, path: string): { right: Set<number>; left: Set<number> } {
  const right = new Set<number>();
  const left = new Set<number>();
  if (!review.baseSha) return { right, left };
  const range = review.head === "WORKTREE" ? [review.baseSha] : [review.baseSha, review.head];
  let patch = "";
  try {
    patch = git(root, ["diff", "-U3", ...range, "--", path]);
  } catch {
    return { right, left };
  }
  for (const m of patch.matchAll(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/gm)) {
    const [os, ol, ns, nl] = [Number(m[1]), m[2] === undefined ? 1 : Number(m[2]), Number(m[3]), m[4] === undefined ? 1 : Number(m[4])];
    for (let i = 0; i < nl; i++) right.add(ns + i);
    for (let i = 0; i < ol; i++) left.add(os + i);
  }
  return { right, left };
}

export function draft(root: string, state: ReviewState, overrides: { event?: Draft["event"]; body?: string } = {}): Draft {
  const { review } = state;
  const cache = new Map<string, ReturnType<typeof diffLines>>();
  const comments: DraftComment[] = [];
  for (const n of [...state.notes].sort((a, b) => a.number - b.number)) {
    if (!goesOut(n)) continue;
    const line = n.lines?.end ?? state.symbols.find((s) => s.id === n.symbolId)?.range?.start ?? null;
    if (!n.file || line == null) {
      comments.push({ noteId: n.id, number: n.number, path: null, line: 0, startLine: null, side: "RIGHT", body: commentBody(n), inline: false });
      continue;
    }
    const side = n.side === "old" ? "LEFT" : "RIGHT";
    if (!cache.has(n.file)) cache.set(n.file, diffLines(root, review, n.file));
    const lines = cache.get(n.file)!;
    const pool = side === "RIGHT" ? lines.right : lines.left;
    const startLine = n.lines && n.lines.start !== n.lines.end ? n.lines.start : null;
    const inline = review.mode === "diff" && pool.has(line) && (startLine === null || pool.has(startLine));
    comments.push({ noteId: n.id, number: n.number, path: n.file, line, startLine, side, body: commentBody(n), inline });
  }

  const verdict = review.verdicts.find((v) => v.by === "user") ?? review.verdicts.find((v) => v.by === "agent");
  const event = overrides.event ?? (verdict?.value === "approve" ? "APPROVE" : verdict?.value === "changes" ? "REQUEST_CHANGES" : "COMMENT");
  let body = (overrides.body ?? review.outgoingBody).trim();
  if (!body) body = defaultBody(state, comments);
  const outside = comments.filter((c) => !c.inline);
  if (outside.length) {
    body += "\n\n" + outside.map((c) => (c.path ? `**${where(c)}**\n\n${c.body}` : c.body)).join("\n\n---\n\n");
  }

  const repo = review.pr ? review.repo : null;
  const markdown = [body, ...comments.filter((c) => c.inline).map((c) => `**${where(c)}**\n\n${c.body}`)].join("\n\n---\n\n");
  return { event, body, comments, target: review.pr ? { pr: review.pr, repo } : null, markdown };
}

const where = (c: DraftComment) => `${c.path}:${c.startLine ? `${c.startLine}-` : ""}${c.line}`;

function defaultBody(state: ReviewState, comments: DraftComment[]): string {
  const findings = state.notes.filter((n) => goesOut(n) && n.kind === "finding");
  const must = findings.filter((n) => n.severity === "blocker").map((n) => n.title.replace(/\.$/, "").toLowerCase());
  const lines: string[] = [];
  const first = state.review.summary.split(/\n\s*\n/)[0]?.trim();
  if (first) lines.push(first);
  if (!comments.length) lines.push("Looks good. Ship.");
  // No "#n" here: on GitHub that links to an issue. Name the findings instead.
  else if (must.length) lines.push(`Before merging: ${must.join("; ")}. The rest can follow.`);
  else lines.push(`${comments.length} comment${comments.length === 1 ? "" : "s"} inline, none blocking.`);
  return lines.join("\n\n");
}

/** The PR moved on after the review was opened: its comments would sit on code that has been replaced. */
export class HeadMoved extends Error {
  readonly reviewed: string;
  readonly current: string;

  constructor(reviewed: string, current: string, pr: number) {
    super(
      `#${pr} changed since you opened this review (${reviewed.slice(0, 7)} → ${current.slice(0, 7)}), so these comments would land on replaced code. Re-open it with \`downstream open --pr ${pr}\` to review what's there now, or send anyway.`,
    );
    this.reviewed = reviewed;
    this.current = current;
  }
}

/** Sends the review. Refuses when the PR's head moved since it was opened, unless `force`. */
export function publish(state: ReviewState, d: Draft, opts: { force?: boolean } = {}): { url: string; comments: number } {
  const { review } = state;
  if (!review.pr || !d.target?.repo) throw new Error("Only pull request reviews can be sent. Open with `downstream open --pr <n>`, or copy the markdown.");
  if (!opts.force) {
    const current = gh(["pr", "view", String(review.pr), "--repo", d.target.repo, "--json", "headRefOid", "--jq", ".headRefOid"], { account: review.account }).trim();
    if (current && current !== review.head) throw new HeadMoved(review.head, current, review.pr);
  }
  const payload = {
    commit_id: review.head,
    event: d.event,
    body: d.body,
    comments: d.comments
      .filter((c): c is DraftComment & { path: string } => c.inline && c.path !== null)
      .map((c) => ({ path: c.path, line: c.line, side: c.side, ...(c.startLine ? { start_line: c.startLine, start_side: c.side } : {}), body: c.body })),
  };
  const out = gh(["api", "-X", "POST", `repos/${d.target.repo}/pulls/${review.pr}/reviews`, "--input", "-"], { account: review.account, input: JSON.stringify(payload) });
  const res = JSON.parse(out) as { html_url: string };
  return { url: res.html_url, comments: payload.comments.length };
}

/** Posts a comment drafted for another pull request (or issue) as the review's account. Returns its URL. */
export function postComment(review: Review, post: Post): string {
  const out = gh(["api", "-X", "POST", `repos/${post.repo}/issues/${post.number}/comments`, "--input", "-"], { account: review.account, input: JSON.stringify({ body: post.body }) });
  return (JSON.parse(out) as { html_url: string }).html_url;
}
