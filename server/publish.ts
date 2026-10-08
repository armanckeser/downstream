// Turning the review you and the agent arrived at into what the PR author sees.
// The conversation stays private; only threads marked to go out are sent, in
// the words drafted for the author, after the user presses Send.
import { execFileSync } from "node:child_process";
import { severityLabel, type Note, type Review, type ReviewState } from "../domain/model.ts";
import { git } from "./analyze/git.ts";

export type DraftComment = {
  noteId: string;
  number: number;
  path: string;
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

/** Which threads go out by default: open findings. Anything else only when someone marks it. */
export function goesOut(n: Note): boolean {
  if (n.outgoing) return n.outgoing.include;
  return n.kind === "finding" && n.status === "open";
}

/** The comment as the PR author reads it. Written in the agent's draft if there is one. */
export function commentBody(n: Note): string {
  if (n.outgoing?.body.trim()) return n.outgoing.body.trim();
  const parts: string[] = [];
  const label = n.kind === "finding" && n.severity ? `**${capitalize(severityLabel[n.severity])}:** ` : "";
  parts.push(`${label}${n.title}`);
  if (n.body) parts.push(n.body);
  if (n.fix) parts.push(`**Fix:** ${n.fix}`);
  if (n.suggestion && n.lines && n.suggestion.lines.start === n.lines.start && n.suggestion.lines.end === n.lines.end) {
    parts.push("```suggestion\n" + n.suggestion.code.replace(/\n$/, "") + "\n```");
  } else if (n.suggestion) {
    parts.push("```\n" + n.suggestion.code.replace(/\n$/, "") + "\n```");
  }
  if (n.impact) parts.push(`**If we skip it:** ${n.impact}`);
  return parts.join("\n\n");
}

const capitalize = (s: string) => s[0]!.toUpperCase() + s.slice(1);

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
    if (!goesOut(n) || !n.file) continue;
    const line = n.lines?.end ?? state.symbols.find((s) => s.id === n.symbolId)?.range?.start ?? null;
    if (line == null) continue;
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
    body += "\n\n" + outside.map((c) => `**${c.path}:${c.startLine ? `${c.startLine}-` : ""}${c.line}**\n\n${c.body}`).join("\n\n---\n\n");
  }

  let repo: string | null = null;
  if (review.pr) {
    try {
      repo = execFileSync("gh", ["repo", "view", "--json", "nameWithOwner", "-q", ".nameWithOwner"], { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    } catch {
      repo = null;
    }
  }
  const markdown = [body, ...comments.filter((c) => c.inline).map((c) => `**${c.path}:${c.startLine ? `${c.startLine}-` : ""}${c.line}**\n\n${c.body}`)].join("\n\n---\n\n");
  return { event, body, comments, target: review.pr ? { pr: review.pr, repo } : null, markdown };
}

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

export function publish(root: string, state: ReviewState, d: Draft): { url: string; comments: number } {
  const { review } = state;
  if (!review.pr || !d.target?.repo) throw new Error("Only pull request reviews can be sent. Open with `downstream open --pr <n>`, or copy the markdown.");
  const payload = {
    commit_id: review.head,
    event: d.event,
    body: d.body,
    comments: d.comments
      .filter((c) => c.inline)
      .map((c) => ({ path: c.path, line: c.line, side: c.side, ...(c.startLine ? { start_line: c.startLine, start_side: c.side } : {}), body: c.body })),
  };
  const out = execFileSync("gh", ["api", "-X", "POST", `repos/${d.target.repo}/pulls/${review.pr}/reviews`, "--input", "-"], {
    cwd: root,
    input: JSON.stringify(payload),
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const res = JSON.parse(out) as { html_url: string };
  return { url: res.html_url, comments: payload.comments.length };
}
