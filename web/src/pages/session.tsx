// An agent session on a PR that has no Downstream review (yet): fixing checks,
// addressing feedback, or the first moments of a review before the agent opens it.
// When the agent opens the review, you move there.
import { useEffect, useRef, useState } from "react";
import { ArrowLeft, ArrowUpRight } from "lucide-react";
import type { HomeView } from "@domain/home.ts";
import { fetchHome, subscribeHome } from "../lib/api.ts";
import { navigate } from "../lib/route.ts";
import { ActivityLog, AgentComposer, Approvals, MoveToTerminal, STATUS_TEXT, StatusDot, useAgent } from "../components/agent.tsx";
import { Mark } from "../components/brand.tsx";

export function Session({ sessionKey }: { sessionKey: string }) {
  const view = useAgent(sessionKey);
  const review = useFollowToReview(sessionKey);
  const [repo, pr] = sessionKey.split("#");
  const back = review ?? "/";

  return (
    <div className="mx-auto flex min-h-[100dvh] max-w-[46rem] flex-col px-5 md:px-8">
      <header className="sticky top-0 z-10 flex items-center gap-3 bg-page/90 py-4 backdrop-blur">
        <button type="button" onClick={() => navigate(back)} className="press flex items-center gap-2 rounded-md p-1 text-ink-3 hover:text-ink" aria-label={review ? "Back to the review" : "Home"} title={review ? "Back to the review" : "Home"}>
          <ArrowLeft size={15} />
          <Mark />
        </button>
        {review ? (
          <button type="button" onClick={() => navigate(review)} className="press truncate rounded-md px-1 font-mono text-[12.5px] text-ink-2 hover:text-ink" title="Open the review">
            {repo}#{pr}
          </button>
        ) : (
          <a href={`https://github.com/${repo}/pull/${pr}`} target="_blank" rel="noreferrer" className="press flex items-center gap-1 truncate rounded-md px-1 font-mono text-[12.5px] text-ink-2 hover:text-ink" title="Open on GitHub">
            {repo}#{pr} <ArrowUpRight size={12} className="opacity-60" />
          </a>
        )}
        {view && (
          <span className="ml-auto flex items-center gap-3">
            <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
              <StatusDot status={view.status} />
              {STATUS_TEXT[view.status]}
            </span>
            <MoveToTerminal view={view} />
          </span>
        )}
      </header>

      <main className="flex-1 pb-6 pt-4">
        {!view ? (
          <p className="pt-16 text-center text-[13.5px] text-ink-3">No agent is running on this pull request. Start it from the home page.</p>
        ) : view.activity.length === 0 ? (
          <p className="pt-16 text-center text-[13.5px] text-ink-3">The agent is starting in {view.root}…</p>
        ) : (
          <ActivityLog view={view} />
        )}
        {view?.resume && (
          <p className="mt-6 rounded-xl border border-line-subtle px-3.5 py-3 text-[13px] text-ink-2">
            Continue in a terminal: <code className="font-mono text-[12px] text-ink">{view.resume}</code>
          </p>
        )}
      </main>

      {view && (
        <footer className="sticky bottom-0 space-y-2 bg-page/95 pb-5 pt-2 backdrop-blur">
          <Approvals view={view} />
          <AgentComposer view={view} />
        </footer>
      )}
    </div>
  );
}

/**
 * A review agent's first minutes happen here; once it opens the review, go to it.
 * A review that already existed means you came to read the log, so it's where back leads.
 */
function useFollowToReview(key: string): string | null {
  const baseline = useRef<string | null | undefined>(undefined);
  const [review, setReview] = useState<string | null>(null);
  useEffect(() => {
    const check = () =>
      fetchHome()
        .then((h: HomeView) => {
          const path = h.sessions[key]?.review?.path ?? null;
          setReview(path);
          if (baseline.current === undefined) baseline.current = path;
          else if (path && path !== baseline.current) {
            baseline.current = path;
            navigate(path);
          }
        })
        .catch(() => {});
    check();
    let t: ReturnType<typeof setTimeout>;
    const off = subscribeHome({
      home: () => {
        clearTimeout(t);
        t = setTimeout(check, 200);
      },
      agent: () => {},
    });
    return off;
  }, [key]);
  return review;
}
