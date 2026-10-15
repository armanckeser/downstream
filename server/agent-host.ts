// Claude Code sessions that Downstream runs itself, through the Agent SDK. You
// press a pull request; a session starts in its repository with a first
// message; what it says and does streams to the browser, and anything that
// isn't read-only waits for your approval there. You can move a session to
// your terminal at any time: Downstream lets go and `claude --resume` picks it up.
import { EventEmitter } from "node:events";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { query, type HookInput, type HookJSONOutput, type Query, type SDKMessage, type SDKUserMessage, type PermissionResult } from "@anthropic-ai/claude-agent-sdk";
import { autoApprove, reachesOthers } from "../domain/approval.ts";
import type { ActivityBody, AgentStatus, AgentView, Approval } from "../domain/agent.ts";
import { ghEnv } from "./gh.ts";
import { newId, now } from "./store.ts";

const skillDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ACTIVITY_LIMIT = 200;

export type StartInput = { key: string; repo: string; pr: number; root: string; account: string; prompt: string; resumeId?: string | null };

class AgentSession {
  readonly view: AgentView;
  private readonly queue: SDKUserMessage[] = [];
  private wake: (() => void) | null = null;
  private closed = false;
  private readonly pending = new Map<string, (r: PermissionResult) => void>();
  private q: Query | null = null;

  constructor(
    input: StartInput,
    private readonly changed: () => void,
  ) {
    this.view = { key: input.key, repo: input.repo, pr: input.pr, root: input.root, sessionId: input.resumeId ?? null, status: "starting", activity: [], approvals: [], error: null, resume: null };
  }

  start(input: StartInput) {
    this.send(input.prompt, false);
    this.q = query({
      prompt: this.input(),
      options: {
        cwd: input.root,
        // 'user' carries the user's model gateway and their own CLAUDE.md; 'project' the repo's.
        settingSources: ["user", "project", "local"],
        // Auto mode: a classifier approves ordinary work, so you're asked only when it can't tell.
        permissionMode: "auto",
        // Runs before the classifier: anything that reaches other people comes to you, whatever it would decide.
        hooks: { PreToolUse: [{ hooks: [async (hook) => outwardHook(hook)] }] },
        canUseTool: (tool, toolInput, { signal, title }) => this.approve(tool, toolInput, signal, title),
        // DOWNSTREAM_HOSTED: the browser is already on its way to the review; `open` shouldn't open another tab.
        env: { ...ghEnv(input.account), DOWNSTREAM_HOSTED: "1" },
        ...(input.resumeId ? { resume: input.resumeId } : {}),
      },
    });
    void this.pump(this.q);
  }

  /** Queue a message for the agent. It reads it when its current turn ends. */
  send(text: string, record = true) {
    if (this.closed) throw new Error("This session has ended.");
    this.queue.push({ type: "user", message: { role: "user", content: text }, parent_tool_use_id: null });
    if (record) this.log({ kind: "user", text });
    this.wake?.();
  }

  decide(approvalId: string, allow: boolean) {
    const resolve = this.pending.get(approvalId);
    if (!resolve) return;
    this.pending.delete(approvalId);
    this.view.approvals = this.view.approvals.filter((a) => a.id !== approvalId);
    resolve(allow ? { behavior: "allow" } : { behavior: "deny", message: "The user declined this in Downstream." });
    this.setStatus(this.view.approvals.length ? "asking" : "running");
  }

  /** Let go of the session so a terminal can resume it; two live writers would interleave the transcript. */
  async handOff(): Promise<string> {
    const id = this.view.sessionId;
    if (!id) throw new Error("The session hasn't started yet.");
    for (const id of [...this.pending.keys()]) this.decide(id, false);
    this.stop();
    await this.q?.interrupt().catch(() => undefined);
    this.q?.close();
    this.view.resume = `cd ${JSON.stringify(this.view.root)} && claude --resume ${id}`;
    this.setStatus("handed-off");
    return this.view.resume;
  }

  stop() {
    this.closed = true;
    this.wake?.();
  }

  get live() {
    return !this.closed;
  }

  private async *input(): AsyncGenerator<SDKUserMessage> {
    while (!this.closed) {
      if (!this.queue.length) await new Promise<void>((r) => (this.wake = r));
      while (this.queue.length) yield this.queue.shift()!;
    }
  }

  private async approve(tool: string, input: Record<string, unknown>, signal: AbortSignal, title: string | undefined): Promise<PermissionResult> {
    if (autoApprove(tool, input, skillDir).allow) return { behavior: "allow", updatedInput: input };
    const approval: Approval = { id: newId("ap"), tool, title: title ?? `Claude wants to use ${tool}`, detail: describeInput(tool, input), at: now() };
    // Register the answer before announcing the question: a listener may answer the moment it hears.
    const answer = new Promise<PermissionResult>((resolve) => {
      this.pending.set(approval.id, (r) => resolve(r.behavior === "allow" ? { ...r, updatedInput: input } : r));
    });
    signal.addEventListener("abort", () => this.decide(approval.id, false), { once: true });
    this.view.approvals = [...this.view.approvals, approval];
    this.setStatus("asking");
    return answer;
  }

  private async pump(q: Query) {
    try {
      for await (const m of q) this.onMessage(m);
      if (this.view.status !== "handed-off") this.setStatus("ended");
    } catch (e) {
      if (this.view.status === "handed-off") return;
      this.view.error = (e as Error).message;
      this.log({ kind: "error", text: this.view.error });
      this.setStatus("failed");
    } finally {
      this.closed = true;
    }
  }

  private onMessage(m: SDKMessage) {
    if (m.type === "system" && m.subtype === "init") {
      this.view.sessionId = m.session_id;
      this.setStatus("running");
      return;
    }
    if (m.type === "system" && m.subtype === "session_state_changed") {
      // "requires_action" is our own approval prompt, already reflected; only idle/running come from here.
      if (this.view.approvals.length === 0 && m.state !== "requires_action") this.setStatus(m.state === "idle" ? "idle" : "running");
      return;
    }
    if (m.type === "assistant" && m.parent_tool_use_id === null) {
      for (const block of m.message.content) {
        if (block.type === "text" && block.text.trim()) this.log({ kind: "text", text: block.text });
        if (block.type === "tool_use") this.log({ kind: "tool", tool: block.name, summary: describeInput(block.name, block.input as Record<string, unknown>) });
      }
      return;
    }
    if (m.type === "result") {
      if (m.subtype !== "success") this.log({ kind: "error", text: `The turn ended early (${m.subtype}).` });
      if (this.view.approvals.length === 0) this.setStatus("idle");
    }
  }

  private log(entry: ActivityBody) {
    this.view.activity = [...this.view.activity, { ...entry, id: newId("ac"), at: now() }].slice(-ACTIVITY_LIMIT);
    this.changed();
  }

  private setStatus(status: AgentStatus) {
    if (this.view.status === status) return;
    this.view.status = status;
    this.changed();
  }
}

/** One line a person can read: the command, the file, the pattern. */
function describeInput(tool: string, input: Record<string, unknown>): string {
  const pick = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : null);
  const text = pick("command") ?? pick("file_path") ?? pick("pattern") ?? pick("url") ?? pick("query") ?? pick("description") ?? pick("prompt") ?? "";
  return (text || tool).replace(new RegExp(`node "?${skillDir}/bin/downstream.mjs"?`, "g"), "downstream").slice(0, 400);
}

export class AgentHost {
  private readonly sessions = new Map<string, AgentSession>();
  /** "changed" with the session key. */
  readonly bus = new EventEmitter();

  constructor() {
    this.bus.setMaxListeners(100);
  }

  start(input: StartInput): AgentView {
    const existing = this.sessions.get(input.key);
    if (existing?.live) return existing.view;
    const session = new AgentSession(input, () => this.bus.emit("changed", input.key));
    this.sessions.set(input.key, session);
    session.start(input);
    this.bus.emit("changed", input.key);
    return session.view;
  }

  view(key: string): AgentView | null {
    return this.sessions.get(key)?.view ?? null;
  }

  views(): AgentView[] {
    return [...this.sessions.values()].map((s) => s.view);
  }

  live(key: string): boolean {
    return this.sessions.get(key)?.live ?? false;
  }

  send(key: string, text: string) {
    this.require(key).send(text);
  }

  decide(key: string, approvalId: string, allow: boolean) {
    this.require(key).decide(approvalId, allow);
  }

  handOff(key: string): Promise<string> {
    return this.require(key).handOff();
  }

  /**
   * The user wrote in Downstream while the agent sat idle (its turn over, not in
   * `downstream wait`): tell it, so a message never waits on an agent that
   * stopped listening.
   */
  nudge(key: string) {
    const s = this.sessions.get(key);
    if (s?.live && s.view.status === "idle") s.send("The user wrote to you in Downstream. Run `downstream wait` to read it and answer there.", false);
  }

  stopAll() {
    for (const s of this.sessions.values()) s.stop();
  }

  private require(key: string): AgentSession {
    const s = this.sessions.get(key);
    if (!s) throw new Error(`No agent session for ${key}.`);
    return s;
  }
}

function outwardHook(hook: HookInput): HookJSONOutput {
  if (hook.hook_event_name !== "PreToolUse") return {};
  const reason = reachesOthers(hook.tool_name, (hook.tool_input ?? {}) as Record<string, unknown>);
  return reason ? { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "ask", permissionDecisionReason: `This is ${reason}, which you approve yourself.` } } : {};
}
