// What leaves Downstream. Threads are a private conversation between you and the
// agent; only these reach anyone else, and only when you press Send or Post.
import { severityLabel, type Note, type Post, type ReviewState } from "./model.ts";

/** Whether this thread's comment is in the review. Open findings are, until someone says otherwise. */
export function goesOut(n: Note): boolean {
  if (n.outgoing) return n.outgoing.include;
  return n.kind === "finding" && n.status === "open";
}

/** The comment as the PR author reads it: the drafted wording if there is one, else the finding as written. */
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

/** Comments drafted for other pull requests that nobody has posted yet. */
export const unposted = (posts: Post[]): Post[] => posts.filter((p) => !p.posted);

/** Everything still waiting to leave: this review (until it's sent) and each unposted comment elsewhere. */
export function pending(state: Pick<ReviewState, "review" | "notes">): { review: number | null; posts: Post[] } {
  const comments = state.review.published ? null : state.notes.filter(goesOut).length;
  return { review: comments, posts: unposted(state.review.posts) };
}
