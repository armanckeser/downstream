// A review: the change on the left, the conversation on the right, and one
// button that is always the next thing to do.
import { useEffect, useState } from "react";
import { ArrowLeft, ArrowUpRight, Check } from "lucide-react";
import { nextMove, type ReviewMove } from "@domain/next-move.ts";
import { prKey } from "@domain/agent.ts";
import { prUrl } from "@domain/model.ts";
import { action } from "../lib/api.ts";
import { useReview, type View } from "../lib/review.tsx";
import { navigate } from "../lib/route.ts";
import { Rail } from "../components/rail.tsx";
import { Overview } from "../components/overview.tsx";
import { Trail } from "../components/trail.tsx";
import { FlowMap } from "../components/map.tsx";
import { Margin } from "../components/margin.tsx";
import { SendReview } from "../components/send-review.tsx";
import { Mark } from "../components/brand.tsx";
import { STATUS_TEXT, useAgent } from "../components/agent.tsx";

const VIEWS: [View, string, string][] = [
  ["overview", "Overview", "o"],
  ["trail", "Trail", "t"],
  ["map", "Map", "m"],
];

export function Review() {
  const { state, error, view, setView, live, presence, openStep, openNote, stepId } = useReview();
  const [pane, setPane] = useState<"rail" | "main" | "margin">("main");
  const [sending, setSending] = useState(false);
  // Closed until you ask for it: the next button walks you through, so the rail is for finding your own way.
  const [railOpen, setRailOpen] = useState(() => localStorage.getItem("ds.rail") === "open");
  useEffect(() => localStorage.setItem("ds.rail", railOpen ? "open" : "closed"), [railOpen]);
  const review = state?.review;
  const agent = useAgent(review?.repo && review.pr ? prKey(review.repo, review.pr) : null);
  const move = state ? nextMove(state, new Set(state.visited)) : null;
  // On a phone the panes are tabs: opening a step from "Ways in" shows its code, or the scroll lands off-screen.
  useEffect(() => {
    if (stepId) setPane("main");
  }, [stepId]);

  const doMove = (m: ReviewMove) => {
    switch (m.kind) {
      case "answer":
        openNote(m.noteId);
        setPane("margin");
        setTimeout(() => document.getElementById(`reply-${m.noteId}`)?.focus(), 60);
        return;
      case "decide":
        openNote(m.noteId);
        return setPane("margin");
      case "walk":
        return openStep(m.stepId);
      case "send":
        return setSending(true);
      case "finish":
        return void action("review.done").then(() => navigate("/"));
      case "sent":
        return navigate("/");
      case "reading":
        return;
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest("textarea, input, select, button, a") || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === "Enter" && move) return doMove(move);
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
  });

  if (error && !state) {
    return (
      <div className="mx-auto max-w-xl px-6 py-24">
        <h1 className="text-xl font-medium text-ink">No review here yet</h1>
        <p className="mt-2 text-ink-2">{error}</p>
        <button type="button" onClick={() => navigate("/")} className="press mt-6 rounded-lg bg-ink px-3.5 py-2 text-[13.5px] font-medium text-page hover:bg-white">
          Back to inbox
        </button>
      </div>
    );
  }

  const agentStatus = agent && !["ended", "failed", "handed-off"].includes(agent.status) ? agent.status : null;
  const presenceText = agentStatus ? `Agent: ${STATUS_TEXT[agentStatus].toLowerCase()}` : `Agent ${presence.agent}`;
  const presenceTone = agentStatus === "asking" || presence.agent === "listening" ? "bg-agent" : agentStatus || presence.agent === "working" ? "bg-agent/60 motion-safe:animate-pulse" : "bg-ink-4";

  return (
    <div className="grid min-h-[100dvh] grid-cols-[minmax(0,1fr)] grid-rows-[auto_1fr] lg:h-[100dvh]">
      <header className="flex items-center gap-3 border-b border-line-subtle px-3 py-2">
        <button type="button" onClick={() => navigate("/")} className="press flex items-center gap-1.5 rounded-md p-1 text-ink-3 hover:bg-overlay hover:text-ink" title="Inbox" aria-label="Back to inbox">
          <ArrowLeft size={14} />
          <Mark />
        </button>
        <button type="button" onClick={() => setRailOpen((o) => !o)} className="min-w-0 text-left" title={railOpen ? "Hide the rail (\\)" : "Show the rail (\\)"}>
          <p className="truncate text-[13.5px] font-medium text-ink">{review?.title ?? "Loading…"}</p>
        </button>
        <div className="ml-1 hidden rounded-lg bg-pane p-0.5 md:flex" role="tablist" aria-label="View">
          {VIEWS.map(([v, label, key]) => (
            <button key={v} role="tab" type="button" aria-selected={view === v} onClick={() => setView(v)} title={`${label} (${key})`} className={`press rounded-md px-2.5 py-1 text-[12.5px] ${view === v ? "bg-overlay text-ink" : "text-ink-3 hover:text-ink-2"}`}>
              {label}
            </button>
          ))}
        </div>
        {state && state.steps.length > 0 && <StepDots />}
        <div className="ml-auto flex items-center gap-3">
          {!live && <span className="text-[12px] text-del">reconnecting…</span>}
          {review && prUrl(review) && (
            <a href={prUrl(review)!} target="_blank" rel="noreferrer" className="press flex items-center gap-1 rounded-md px-2 py-1 text-[12.5px] text-ink-3 hover:bg-overlay hover:text-ink" title="Open the pull request on GitHub">
              GitHub <ArrowUpRight size={12} className="opacity-60" />
            </a>
          )}
          <span className={`size-2 rounded-full ${presenceTone}`} title={presenceText} aria-label={presenceText} />
          {move && move.kind !== "send" && move.kind !== "sent" && review?.mode === "diff" && (
            <button type="button" onClick={() => setSending(true)} className="press hidden rounded-md px-2 py-1 text-[12.5px] text-ink-3 hover:bg-overlay hover:text-ink sm:block">
              Send…
            </button>
          )}
          {move && <NextButton move={move} onPress={() => doMove(move)} />}
          {sending && <SendReview onClose={() => setSending(false)} />}
        </div>
      </header>

      <div className={`min-h-0 lg:grid ${railOpen ? "lg:grid-cols-[16rem_minmax(0,1fr)_23rem]" : "lg:grid-cols-[minmax(0,1fr)_23rem]"}`}>
        <div className="flex border-b border-line-subtle lg:hidden" role="tablist">
          {(["rail", "main", "margin"] as const).map((p) => (
            <button key={p} type="button" role="tab" aria-selected={pane === p} onClick={() => setPane(p)} className={`press flex-1 py-2.5 text-[13px] pointer-coarse:min-h-11 ${pane === p ? "text-ink" : "text-ink-3"}`}>
              {p === "rail" ? "Ways in" : p === "main" ? "Code" : "Threads"}
            </button>
          ))}
        </div>
        <div className={`min-h-0 border-line-subtle lg:border-r ${railOpen ? "lg:block" : "lg:hidden"} ${pane === "rail" ? "block" : "hidden"}`}>
          <Rail />
        </div>
        <main className={`min-h-0 min-w-0 overflow-x-clip lg:block lg:overflow-x-hidden lg:overflow-y-auto ${pane === "main" ? "block" : "hidden"} ${view === "map" ? "h-[calc(100dvh-90px)] overflow-hidden lg:h-auto" : ""}`}>
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
          <Margin agent={agent} />
        </div>
      </div>
    </div>
  );
}

const MOVE_LABEL: Record<ReviewMove["kind"], (m: ReviewMove, visited: number) => string> = {
  sent: () => "Back to inbox",
  answer: (m) => `Answer #${(m as Extract<ReviewMove, { kind: "answer" }>).number}`,
  decide: (m) => `Decide #${(m as Extract<ReviewMove, { kind: "decide" }>).number}`,
  reading: () => "Agent is reading",
  walk: (m, visited) => {
    const w = m as Extract<ReviewMove, { kind: "walk" }>;
    return visited === 0 ? "Start walkthrough" : `Step ${w.order} of ${w.total}`;
  },
  send: () => "Send review",
  finish: () => "Finish",
};

/** The one primary action. Enter presses it. */
function NextButton({ move, onPress }: { move: ReviewMove; onPress: () => void }) {
  const { state } = useReview();
  const label = MOVE_LABEL[move.kind](move, state?.visited.length ?? 0);
  const waiting = move.kind === "reading";
  return (
    <button
      type="button"
      onClick={onPress}
      disabled={waiting}
      title={waiting ? "It appears as soon as the agent writes the walkthrough" : `${label} (↵)`}
      className={`press flex items-center gap-1.5 whitespace-nowrap rounded-lg px-3 py-1.5 text-[13px] font-medium ${waiting ? "bg-overlay text-ink-3" : "bg-ink text-page hover:bg-white"}`}
    >
      {move.kind === "sent" && <Check size={13} />}
      {waiting && <span className="size-1.5 rounded-full bg-agent/70 motion-safe:animate-pulse" />}
      {label}
    </button>
  );
}

/** Where you are in the walkthrough, at a glance: filled = read, ring = here. */
function StepDots() {
  const { state, stepId, openStep } = useReview();
  if (!state) return null;
  const seen = new Set(state.visited);
  return (
    <div className="ml-1 hidden items-center gap-1 lg:flex" aria-label="Walkthrough">
      {state.steps.map((s) => (
        <button
          key={s.id}
          type="button"
          onClick={() => openStep(s.id)}
          title={`${s.order}. ${s.title}`}
          aria-label={`Step ${s.order}: ${s.title}`}
          aria-current={s.id === stepId ? "step" : undefined}
          className="grid size-4 place-items-center"
        >
          <span className={`block rounded-full transition-[background-color,box-shadow] duration-150 ${s.id === stepId ? "size-2 bg-agent shadow-[0_0_0_3px_rgb(242_166_59/0.18)]" : seen.has(s.id) ? "size-1.5 bg-ink-2" : "size-1.5 bg-ink-4"}`} />
        </button>
      ))}
    </div>
  );
}
