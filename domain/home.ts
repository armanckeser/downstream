// The home page: one account's inbox, plus what's already in motion for each PR.
import type { AgentStatus } from "./agent.ts";
import type { Inbox } from "./inbox.ts";
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
