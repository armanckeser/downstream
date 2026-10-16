// The one thing to do next on a review. The review screen shows it as its only
// primary button, so the next operation is never a question.
import type { Note, ReviewState } from "./model.ts";
import { unposted } from "./outgoing.ts";

export type ReviewMove =
  /** The review went out; nothing left here. */
  | { kind: "sent"; url: string }
  /** The review went out, but comments drafted for other PRs are still unposted. */
  | { kind: "post"; count: number }
  /** The agent is waiting on you in a thread. */
  | { kind: "answer"; noteId: string; number: number }
  /** The agent hasn't written anything to read yet. */
  | { kind: "reading" }
  /** An open thread the agent raised that you haven't settled: send it, keep it, or got it. */
  | { kind: "decide"; noteId: string; number: number }
  /** The next step of the walkthrough you haven't seen. */
  | { kind: "walk"; stepId: string; order: number; total: number }
  /** Everything's read: send the review (or, for a tour, end it). */
  | { kind: "send" }
  | { kind: "finish" };

/** The agent spoke last in an open thread that asks something of you. */
export function awaitsYou(n: Note): boolean {
  if (n.status !== "open") return false;
  const last = n.replies.at(-1)?.author ?? n.author;
  return last === "agent" && (n.kind === "question" || n.replies.length > 0);
}

/** An open thread the agent raised that nobody answered yet: yours to settle. */
export function awaitsDecision(n: Note): boolean {
  return n.status === "open" && n.author === "agent" && n.replies.length === 0;
}

const first = (notes: Note[]) => [...notes].sort((a, b) => a.number - b.number)[0];

/**
 * Order matters: someone blocked on you comes before reading on, and reading
 * comes before settling what's left open, which comes before sending. `visited` holds the steps you've opened.
 */
export function nextMove(state: ReviewState, visited: ReadonlySet<string>): ReviewMove {
  const { review, steps, notes } = state;
  if (review.published) {
    const left = unposted(review.posts).length;
    return left ? { kind: "post", count: left } : { kind: "sent", url: review.published.url };
  }
  const blocked = first(notes.filter(awaitsYou));
  if (blocked) return { kind: "answer", noteId: blocked.id, number: blocked.number };
  const nothingWritten = !review.summary && steps.length === 0 && notes.length === 0;
  if (nothingWritten && review.status === "drafting") return { kind: "reading" };
  const unseen = steps.find((s) => !visited.has(s.id));
  if (unseen) return { kind: "walk", stepId: unseen.id, order: unseen.order, total: steps.length };
  const open = first(notes.filter(awaitsDecision));
  if (open) return { kind: "decide", noteId: open.id, number: open.number };
  return review.mode === "teach" ? { kind: "finish" } : { kind: "send" };
}
