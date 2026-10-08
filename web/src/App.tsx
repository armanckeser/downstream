import { useEffect, useState } from "react";
import { Check, RotateCw } from "lucide-react";
import { action } from "./lib/api.ts";
import { useReview, type View } from "./lib/review.tsx";
import { Rail } from "./components/rail.tsx";
import { Overview } from "./components/overview.tsx";
import { Trail } from "./components/trail.tsx";
import { FlowMap } from "./components/map.tsx";
import { Margin } from "./components/margin.tsx";
import { SendReview } from "./components/send-review.tsx";

const VIEWS: [View, string, string][] = [
  ["overview", "Overview", "o"],
  ["trail", "Trail", "t"],
  ["map", "Map", "m"],
];

export function App() {
  const { state, error, view, setView, live, presence, openStep, stepId } = useReview();
  const [pane, setPane] = useState<"rail" | "main" | "margin">("main");
  const [sending, setSending] = useState(false);
  // The rail is for finding your way in; once you're reading, give the code its width.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("ds.rail") !== "closed");
  useEffect(() => localStorage.setItem("ds.rail", railOpen ? "open" : "closed"), [railOpen]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("textarea, input, select") || e.metaKey || e.ctrlKey || e.altKey) return;
      const hit = VIEWS.find(([, , k]) => k === e.key);
      if (hit) return setView(hit[0]);
      if (e.key === "\\") return setRailOpen((o) => !o);
      if ((e.key === "j" || e.key === "k") && state?.steps.length) {
        const i = state.steps.findIndex((s) => s.id === stepId);
        const next = e.key === "j" ? Math.min(state.steps.length - 1, i + 1) : Math.max(0, i - 1);
        openStep(state.steps[next]!.id);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [state, stepId, setView, openStep]);

  if (error && !state) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24">
        <p className="eyebrow">Downstream</p>
        <h1 className="mt-2 text-xl font-medium text-ink">No review to show</h1>
        <p className="mt-2 text-ink-2">{error}</p>
        <p className="mt-4 text-[13px] text-ink-3">
          Ask your coding agent to review a change, or run <code className="font-mono text-ink-2">downstream open</code> in the repository.
        </p>
      </div>
    );
  }

  const review = state?.review;
  const openThreads = state?.notes.filter((n) => n.status === "open").length ?? 0;
  const myVerdict = review?.verdicts.find((v) => v.by === "user");
  const agentVerdict = review?.verdicts.find((v) => v.by === "agent");

  return (
    <div className="grid min-h-[100dvh] grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] lg:h-[100dvh]">
      <header className="flex items-center gap-3 border-b border-line-subtle px-4 py-2">
        <button type="button" onClick={() => setRailOpen((o) => !o)} className="press hidden rounded-md p-1 hover:bg-overlay lg:block" title={railOpen ? "Hide the rail (\)" : "Show the rail (\)"} aria-pressed={railOpen}>
          <Mark />
        </button>
        <span className="lg:hidden">
          <Mark />
        </span>
        <div className="min-w-0">
          <p className="truncate text-[13.5px] font-medium text-ink">{review?.title ?? "Loading…"}</p>
        </div>
        <div className="ml-2 hidden rounded-md border border-line-subtle p-0.5 md:flex" role="tablist" aria-label="View">
          {VIEWS.map(([v, label, key]) => (
            <button key={v} role="tab" type="button" aria-selected={view === v} onClick={() => setView(v)} className={`press flex items-center gap-1.5 rounded-[4px] px-2.5 py-1 text-[12.5px] ${view === v ? "bg-overlay text-ink" : "text-ink-3 hover:text-ink-2"}`}>
              {label}
              <span className="font-mono text-[10px] text-ink-4">{key}</span>
            </button>
          ))}
        </div>
        <div className="ml-auto flex items-center gap-3">
          {!live && <span className="font-mono text-2xs text-del">reconnecting…</span>}
          <span className="hidden items-center gap-1.5 font-mono text-2xs text-ink-3 sm:flex" title="Is the agent in the room?">
            <span className={`size-1.5 rounded-full ${presence.agent === "listening" ? "bg-agent" : presence.agent === "working" ? "bg-agent/50" : "bg-ink-4"}`} />
            agent {presence.agent}
          </span>
          {agentVerdict && (
            <span className="hidden font-mono text-2xs text-agent-ink lg:inline" title={agentVerdict.body}>
              agent: {agentVerdict.value === "changes" ? "requests changes" : agentVerdict.value}
            </span>
          )}
          {review?.head === "WORKTREE" && <Reread />}
          <span className="hidden font-mono text-2xs text-ink-3 sm:inline">{openThreads} open</span>
          <button type="button" onClick={() => setSending(true)} className="press flex items-center gap-1.5 whitespace-nowrap rounded-md bg-ink px-2.5 py-1 text-[12.5px] font-medium text-page hover:bg-white">
            {review?.published ? (
              <>
                <Check size={13} /> Sent
              </>
            ) : (
              <>
                {myVerdict ? "Review ready" : "Send"}
                <span className="hidden sm:inline">{myVerdict ? "" : " review"}</span>
              </>
            )}
          </button>
          {sending && <SendReview onClose={() => setSending(false)} />}
        </div>
      </header>

      <div className={`min-h-0 lg:grid ${railOpen ? "lg:grid-cols-[17rem_minmax(0,1fr)_23rem]" : "lg:grid-cols-[minmax(0,1fr)_23rem]"}`}>
        <div className="flex border-b border-line-subtle lg:hidden" role="tablist">
          {(["rail", "main", "margin"] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={pane === p} onClick={() => setPane(p)} className={`press flex-1 py-2.5 text-[13px] pointer-coarse:min-h-11 ${pane === p ? "text-ink" : "text-ink-3"}`}>
              {p === "rail" ? "Ways in" : p === "main" ? "Code" : `Threads ${openThreads}`}
            </button>
          ))}
        </div>
        <div className={`min-h-0 border-line-subtle lg:border-r ${railOpen ? "lg:block" : "lg:hidden"} ${pane === "rail" ? "block" : "hidden"}`}>
          <Rail />
        </div>
        <main className={`min-h-0 min-w-0 overflow-x-hidden overflow-y-auto lg:block ${pane === "main" ? "block" : "hidden"} ${view === "map" ? "h-[calc(100dvh-90px)] overflow-hidden lg:h-auto" : ""}`}>
          <div className="mb-1 flex gap-1 px-4 pt-3 md:hidden">
            {VIEWS.map(([v, label]) => (
              <button key={v} type="button" onClick={() => setView(v)} className={`press rounded-md px-2.5 py-1 text-[12.5px] pointer-coarse:min-h-11 ${view === v ? "bg-overlay text-ink" : "text-ink-3"}`}>
                {label}
              </button>
            ))}
          </div>
          {view === "overview" && <Overview />}
          {view === "trail" && <Trail />}
          {view === "map" && <FlowMap />}
        </main>
        <div className={`min-h-0 border-line-subtle lg:block lg:border-l ${pane === "margin" ? "block h-[calc(100dvh-90px)]" : "hidden"} lg:h-auto`}>
          <Margin />
        </div>
      </div>
    </div>
  );
}

/** Working-tree reviews can go stale as code is fixed; re-read keeps threads and the walkthrough. */
function Reread() {
  const [busy, setBusy] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      onClick={() => {
        setBusy(true);
        void action("review.reanalyze").finally(() => setBusy(false));
      }}
      className="press flex items-center gap-1.5 rounded-md px-2 py-1 font-mono text-2xs text-ink-3 hover:bg-overlay hover:text-ink disabled:opacity-50"
      title="Re-read the working tree after edits"
    >
      <RotateCw size={12} className={busy ? "opacity-50" : ""} /> {busy ? "reading…" : "re-read"}
    </button>
  );
}

function Mark() {
  return (
    <svg width="20" height="20" viewBox="0 0 32 32" aria-label="Downstream" className="shrink-0">
      <path d="M9 7v6c0 3 2 5 5 5h4c3 0 5 2 5 5v2" fill="none" stroke="var(--color-ink)" strokeWidth="2.6" strokeLinecap="round" />
      <circle cx="9" cy="7" r="3" fill="var(--color-agent)" />
      <circle cx="23" cy="25" r="2.8" fill="none" stroke="var(--color-ink)" strokeWidth="2.2" />
    </svg>
  );
}
