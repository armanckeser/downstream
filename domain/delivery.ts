// Where the user's last word in a thread stands with the agent.
import type { Note, Presence } from "./model.ts";

/**
 * - unread: `downstream wait` hasn't handed it to the agent yet
 * - answering: handed over, and the agent is busy since (presumably on this)
 * - read: handed over, and the agent went back to listening without replying
 * - stalled: handed over, then the agent went quiet without replying
 */
export type Delivery = "unread" | "answering" | "read" | "stalled";

/** Null when there's nothing to wait on: the thread is settled, or the agent spoke last. */
export function delivery(note: Note, readThrough: string | null, presence: Presence): Delivery | null {
  if (note.status !== "open") return null;
  const last = note.replies.at(-1) ?? note;
  if (last.author !== "user") return null;
  const read = readThrough !== null && last.createdAt <= readThrough;
  if (!read) return "unread";
  // A plain note or flag doesn't ask for an answer, so a busy agent isn't "answering" it.
  const expectsAnswer = note.kind === "question" || note.replies.length > 0;
  switch (presence.agent) {
    case "working":
      return expectsAnswer ? "answering" : "read";
    case "listening":
      return "read";
    case "away":
      return expectsAnswer ? "stalled" : "read";
  }
}
