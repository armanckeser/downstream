// The agent session Downstream runs for a PR: what it's doing, what it wants
// your permission for, a line to talk to it, and a way to move it to your terminal.
import { useCallback, useEffect, useRef, useState } from "react";
import { ArrowUp, Check, SquareTerminal } from "lucide-react";
import type { AgentStatus, AgentView, Approval } from "@domain/agent.ts";
import { ApiError, fetchAgent, homeAction, subscribeHome } from "../lib/api.ts";
import { Markdown } from "./markdown.tsx";

/** A session's live state, or null while there's none. */
export function useAgent(key: string | null): AgentView | null {
  const [view, setView] = useState<AgentView | null>(null);
  useEffect(() => {
    setView(null);
    if (!key) return;
    let live = true;
    fetchAgent(key)
      .then((v) => live && setView(v))
      .catch((e) => {
        if (!(e instanceof ApiError)) throw e;
      });
    const off = subscribeHome({ home: () => {}, agent: (v) => v.key === key && setView(v) });
    return () => {
      live = false;
      off();
    };
  }, [key]);
  return view;
}

export const STATUS_TEXT: Record<AgentStatus, string> = {
  starting: "Starting",
  running: "Working",
  idle: "Waiting for you",
  asking: "Needs your approval",
  "handed-off": "In your terminal",
  ended: "Ended",
  failed: "Stopped",
};

export function StatusDot({ status }: { status: AgentStatus }) {
  const tone =
    status === "asking" ? "bg-agent" : status === "running" || status === "starting" ? "bg-agent/70 motion-safe:animate-pulse" : status === "idle" ? "bg-agent/50" : status === "failed" ? "bg-del" : "bg-ink-4";
  return <span className={`size-1.5 shrink-0 rounded-full ${tone}`} aria-hidden />;
}

/** Tool calls waiting on you. The decline button is the default; approving is never one stray keystroke away. */
export function Approvals({ view }: { view: AgentView }) {
  if (view.approvals.length === 0) return null;
  return (
    <ul className="space-y-2">
      {view.approvals.map((a) => (
        <ApprovalCard key={a.id} sessionKey={view.key} approval={a} />
      ))}
    </ul>
  );
}

function ApprovalCard({ sessionKey, approval }: { sessionKey: string; approval: Approval }) {
  const [busy, setBusy] = useState(false);
  const decide = (allow: boolean) => {
    setBusy(true);
    void homeAction("agent.decide", { key: sessionKey, approvalId: approval.id, allow }).finally(() => setBusy(false));
  };
  return (
    <li className="fade-in rounded-xl border border-agent-line/50 bg-agent-wash px-3.5 py-3">
      <p className="text-[13px] font-medium text-ink">{approval.title}</p>
      {approval.detail && <pre className="mt-1.5 max-h-40 overflow-auto whitespace-pre-wrap break-all rounded-md bg-code px-2.5 py-2 font-mono text-[11.5px] leading-[18px] text-ink-2">{approval.detail}</pre>}
      <div className="mt-2.5 flex justify-end gap-1.5">
        <button type="button" autoFocus disabled={busy} onClick={() => decide(false)} className="press rounded-md px-3 py-1.5 text-[12.5px] text-ink-2 hover:bg-overlay disabled:opacity-40">
          Deny
        </button>
        <button type="button" disabled={busy} onClick={() => decide(true)} className="press rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-page hover:bg-white disabled:opacity-40">
          Allow
        </button>
      </div>
    </li>
  );
}

/** Everything the agent said and did, newest last. */
export function ActivityLog({ view }: { view: AgentView }) {
  const end = useRef<HTMLDivElement>(null);
  useEffect(() => {
    // A block, not an expression: Chrome's scrollIntoView returns a Promise, which React would call as the cleanup.
    end.current?.scrollIntoView({ block: "end" });
  }, [view.activity.length]);
  return (
    <ol className="space-y-3">
      {view.activity.map((a) => (
        <li key={a.id}>
          {a.kind === "text" && (
            <div className="voice">
              <Markdown text={a.text} />
            </div>
          )}
          {a.kind === "tool" && (
            <p className="flex items-baseline gap-2 font-mono text-[11.5px] text-ink-3">
              <span className="shrink-0 text-ink-4">{a.tool}</span>
              <span className="truncate" title={a.summary}>
                {a.summary}
              </span>
            </p>
          )}
          {a.kind === "user" && <p className="ml-auto max-w-[85%] rounded-xl bg-overlay px-3 py-2 text-[13.5px] text-ink">{a.text}</p>}
          {a.kind === "error" && <p className="text-[12.5px] text-del">{a.text}</p>}
        </li>
      ))}
      <div ref={end} />
    </ol>
  );
}

export function AgentComposer({ view, placeholder = "Message the agent…" }: { view: AgentView; placeholder?: string }) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const ended = ["ended", "failed", "handed-off"].includes(view.status);
  const send = async () => {
    const body = text.trim();
    if (!body) return;
    setError(null);
    try {
      await homeAction("agent.send", { key: view.key, text: body });
      setText("");
    } catch (e) {
      setError((e as Error).message);
    }
  };
  if (ended) return null;
  return (
    <div>
      <div className="relative">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              void send();
            }
          }}
          rows={2}
          placeholder={placeholder}
          className="block w-full resize-none rounded-xl border border-line bg-page px-3 py-2.5 pr-11 text-[13.5px] text-ink placeholder:text-ink-4 focus:border-ink-4 focus:outline-none"
        />
        <button type="button" onClick={() => void send()} disabled={!text.trim()} aria-label="Send" className="press absolute bottom-2 right-2 grid size-7 place-items-center rounded-lg bg-ink text-page hover:bg-white disabled:opacity-25">
          <ArrowUp size={14} />
        </button>
      </div>
      {error && <p className="mt-1 text-[12px] text-del">{error}</p>}
    </div>
  );
}

/** Stop the session here and copy the command that resumes it in a terminal. */
export function MoveToTerminal({ view }: { view: AgentView }) {
  const [copied, setCopied] = useState<string | null>(view.resume);
  const [error, setError] = useState<string | null>(null);
  const move = useCallback(async () => {
    setError(null);
    try {
      const command = view.resume ?? (await homeAction<{ command: string }>("agent.handoff", { key: view.key })).command;
      await navigator.clipboard.writeText(command).catch(() => {});
      setCopied(command);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [view.key, view.resume]);
  if (!view.sessionId) return null;
  return (
    <div className="flex min-w-0 items-center gap-2">
      <button
        type="button"
        onClick={() => void move()}
        className="press flex shrink-0 items-center gap-1.5 rounded-md px-2 py-1 text-[12px] text-ink-3 hover:bg-overlay hover:text-ink"
        title={copied ? copied : "Stop it here and copy `claude --resume …` for your terminal"}
      >
        {copied ? <Check size={13} /> : <SquareTerminal size={13} />}
        {copied ? "Copied resume command" : "Move to terminal"}
      </button>
      {error && <span className="truncate text-[12px] text-del">{error}</span>}
    </div>
  );
}
