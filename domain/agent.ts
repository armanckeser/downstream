// An agent session Downstream runs for you, as the browser sees it.

/**
 * - starting: the process is coming up
 * - running: the agent is working on a turn
 * - idle: it finished its turn and waits for a message
 * - asking: a tool call waits for your approval
 * - handed-off: you moved it to a terminal
 * - ended / failed: the process is gone
 */
export type AgentStatus = "starting" | "running" | "idle" | "asking" | "handed-off" | "ended" | "failed";

export type ActivityBody =
  | { kind: "text"; text: string }
  | { kind: "tool"; tool: string; summary: string }
  | { kind: "user"; text: string }
  | { kind: "error"; text: string };
export type Activity = { id: string; at: string } & ActivityBody;

export type Approval = { id: string; tool: string; title: string; detail: string; at: string };

export type AgentView = {
  key: string;
  repo: string;
  pr: number;
  root: string;
  sessionId: string | null;
  status: AgentStatus;
  activity: Activity[];
  approvals: Approval[];
  error: string | null;
  /** What to run in a terminal to continue this session there. */
  resume: string | null;
};

/** `owner/name#42`: how sessions, reviews and inbox rows find each other. */
export const prKey = (repo: string, pr: number) => `${repo.toLowerCase()}#${pr}`;
