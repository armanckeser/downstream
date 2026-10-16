// The home page: one account's inbox, plus what's already in motion for each PR.
import type { AgentStatus } from "./agent.ts";
import type { Inbox, Move } from "./inbox.ts";
import type { ReviewMove } from "./next-move.ts";

/** What's already happening on a pull request: an agent session, a Downstream review, or both. */
export type PrSession = {
  agent: { status: AgentStatus; line: string | null; approvals: number } | null;
  review: { path: string; title: string; move: ReviewMove } | null;
};

export type HomeView = {
  accounts: { login: string; avatar: string | null }[];
  account: string | null;
  inbox: Inbox | null;
  fetchedAt: string | null;
  refreshing: boolean;
  error: string | null;
  /** By `prKey`. */
  sessions: Record<string, PrSession>;
};

/**
 * A review you sent before the PR came back to you belongs to the last round:
 * pressing Re-review starts a new one instead of reopening the sent one, which
 * has nothing left to do.
 */
export function lastRound(published: { at: string } | null, move: Move): boolean {
  return published !== null && move.kind === "rereview" && published.at < move.because.at;
}
