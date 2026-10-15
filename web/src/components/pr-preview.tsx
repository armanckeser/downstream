// The preview: a pull request at a glance (what it says it does, how big it is,
// where checks and reviews stand), so you decide before anything starts.
// Nothing runs until you press the button.
import { useEffect, useState } from "react";
import { ArrowUpRight, Check, CircleDashed, CornerDownLeft, FileMinus, FilePlus, FileText, MessageSquare, X } from "lucide-react";
import { MOVES, type Quadrant, type Triaged } from "@domain/inbox.ts";
import type { PrSession } from "@domain/home.ts";
import { reviewable, type PrDetail, type Reviewable, type ReviewState } from "@domain/pr-detail.ts";
import { fetchPrDetail } from "../lib/api.ts";
import { timeAgo } from "../lib/time.ts";
import { Markdown } from "./markdown.tsx";
import { Tip } from "./menu.tsx";
import { Avatar, MOVE_ICON, PrLink, QuadrantMenu, SessionLine, StackLine, verbOf, whyText } from "./pull-request.tsx";

const FILES_SHOWN = 8;
const BODY_FOLDED_CHARS = 900;

/** What pressing the button does, in words: the agent only starts when you say so. */
function startLabel(item: Triaged, session: PrSession | null): string {
  if (session?.review || session?.agent) return "Resume";
  const opens = MOVES[item.move.kind].opens;
  if (opens === "github") return `${verbOf(item)} on GitHub`;
  if (opens === "review") return item.move.kind === "rereview" ? "Start re-review" : "Start review";
  return `${verbOf(item)} with the agent`;
}

export function PrPreview({ item, session, starting, onStart, onChoose, onClose }: {
  item: Triaged;
  session: PrSession | null;
  starting: boolean;
  onStart: () => void;
  onChoose: (q: Quadrant | null) => void;
  onClose: () => void;
}) {
  const pr = item.lead;
  const [detail, setDetail] = useState<PrDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);

  useEffect(() => {
    let live = true;
    setDetail(null);
    setError(null);
    setExpanded(false);
    fetchPrDetail(pr.repo, pr.number)
      .then((d) => live && setDetail(d))
      .catch((e: Error) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [pr.repo, pr.number]);

  const opens = MOVES[item.move.kind].opens;
  return (
    <aside aria-label="Pull request preview" className="slide-in-right fixed inset-y-0 right-0 z-20 flex w-full flex-col border-l border-line-subtle bg-page shadow-[-24px_0_48px_rgb(0_0_0/0.35)] md:w-[32rem]">
      <header className="flex items-center gap-2 px-5 pb-2 pt-4 text-[12.5px] text-ink-3">
        <span className="text-agent-ink">{MOVE_ICON[item.move.kind](14)}</span>
        <span className="min-w-0 flex-1 truncate">{whyText(item.why, item)}</span>
        <QuadrantMenu item={item} onChoose={onChoose} />
        <Tip label="Close (esc)" side="bottom">
          <button type="button" onClick={onClose} aria-label="Close preview" className="press grid size-7 place-items-center rounded-md text-ink-3 hover:bg-overlay hover:text-ink">
            <X size={15} />
          </button>
        </Tip>
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
        <h2 className="text-[19px] font-semibold leading-snug tracking-[-0.01em] text-ink">{pr.title}</h2>
        <div className="mt-2 flex flex-wrap items-center gap-x-2 gap-y-1 text-[12.5px] text-ink-3">
          <Avatar src={pr.authorAvatar} name={pr.authorName ?? pr.author} size={16} />
          <span>{pr.role === "author" ? "You" : (pr.authorName ?? pr.author)}</span>
          <span className="text-ink-4">·</span>
          <PrLink item={item} />
          {detail && (
            <>
              <span className="text-ink-4">·</span>
              <span>opened {timeAgo(detail.createdAt)} ago</span>
            </>
          )}
        </div>
        {item.stack && <StackLine item={item} />}
        <SessionLine session={session} />

        {error && <p className="mt-6 text-[13px] text-del">{error}</p>}
        {!detail && !error && <PreviewSkeleton />}
        {detail && (
          <>
            <Facts detail={detail} files={reviewable(detail.files)} unresolved={pr.unresolvedThreads} />
            <Description body={detail.body} expanded={expanded} onExpand={() => setExpanded(true)} />
            <Files detail={detail} files={reviewable(detail.files)} url={pr.url} />
          </>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-line-subtle px-5 py-3">
        <button type="button" onClick={onStart} disabled={starting} className="press inline-flex items-center gap-2 rounded-lg bg-ink px-4 py-2 text-[14px] font-medium text-page hover:bg-white disabled:opacity-60">
          {starting ? "Starting…" : startLabel(item, session)}
          {opens === "github" && !session ? <ArrowUpRight size={15} /> : <CornerDownLeft size={14} className="opacity-50" />}
        </button>
        {opens !== "github" && (
          <a href={pr.url} target="_blank" rel="noreferrer" className="press inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-[13px] text-ink-2 hover:bg-pane hover:text-ink">
            GitHub <ArrowUpRight size={13} className="opacity-60" />
          </a>
        )}
        <span className="ml-auto hidden font-mono text-2xs text-ink-4 md:block">
          <span className="kbd">↵</span> {opens === "github" ? "open" : "start"} · <span className="kbd">j</span> <span className="kbd">k</span> next
        </span>
      </footer>
    </aside>
  );
}

const REVIEW_TONE: Record<ReviewState, { label: string; className: string }> = {
  approved: { label: "approved", className: "bg-add" },
  changes_requested: { label: "asked for changes", className: "bg-del" },
  commented: { label: "commented", className: "bg-ink-3" },
  dismissed: { label: "dismissed", className: "bg-ink-4" },
};

/** Size, checks, reviews and open threads: one line each, only when there's something to say. */
function Facts({ detail, files, unresolved }: { detail: PrDetail; files: Reviewable; unresolved: number }) {
  const { checks } = detail;
  const waitingOn = detail.requested;
  // GitHub lists at most 100 files; past that the split is partial, so the totals stand.
  const complete = detail.files.length === detail.changedFiles;
  const additions = complete ? files.additions : detail.additions;
  const deletions = complete ? files.deletions : detail.deletions;
  const skipped = complete && (detail.additions !== additions || detail.deletions !== deletions);
  return (
    <dl className="mt-5 grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-3 gap-y-2.5 rounded-xl border border-line-subtle px-4 py-3 text-[13px]">
      <dt className="text-ink-3">Size</dt>
      <dd className="text-ink-2">
        <span className="font-mono text-add">+{additions}</span> <span className="font-mono text-del">−{deletions}</span>
        <span className="text-ink-3"> · {plural(files.code.length, "code file")}{files.others.test ? `, ${plural(files.others.test, "test")}` : ""}</span>
        {skipped && (
          <Tip label={`+${detail.additions} −${detail.deletions} counting lockfiles and other generated files`}>
            <span className="ml-1.5 text-ink-4 underline decoration-dotted underline-offset-2">not counting generated</span>
          </Tip>
        )}
      </dd>

      <dt className="text-ink-3">Checks</dt>
      <dd className="flex min-w-0 items-center gap-1.5 text-ink-2">
        {checks.failing.length > 0 ? (
          <Tip label={checks.failing.slice(0, 6).join(", ") + (checks.failing.length > 6 ? ", …" : "")}>
            <span className="text-del">{checks.failing.length} failing</span>
          </Tip>
        ) : checks.pending.length > 0 ? (
          <span className="flex items-center gap-1.5"><CircleDashed size={13} className="text-ink-3" /> {checks.pending.length} running</span>
        ) : checks.passing > 0 ? (
          <span className="flex items-center gap-1.5"><Check size={13} className="text-add" /> {checks.passing} passing</span>
        ) : (
          <span className="text-ink-3">none</span>
        )}
        {checks.failing.length > 0 && checks.passing > 0 && <span className="text-ink-3">· {checks.passing} passing</span>}
      </dd>

      {(detail.reviews.length > 0 || waitingOn.length > 0) && (
        <>
          <dt className="text-ink-3">Reviews</dt>
          <dd className="flex flex-wrap items-center gap-1.5">
            {detail.reviews.map((r) => (
              <Tip key={r.login} label={`${r.name ?? r.login} ${REVIEW_TONE[r.state].label}`}>
                <span className="relative">
                  <Avatar src={r.avatar} name={r.name ?? r.login} size={20} />
                  <span className={`absolute -bottom-0.5 -right-0.5 size-2 rounded-full ring-2 ring-page ${REVIEW_TONE[r.state].className}`} />
                </span>
              </Tip>
            ))}
            {waitingOn.map((r) => (
              <Tip key={r.kind === "team" ? `team:${r.name}` : r.login} label={r.kind === "team" ? `Team ${r.name} is asked to review` : `${r.name ?? r.login} is asked to review`}>
                {r.kind === "team" ? (
                  <span className="rounded-full border border-dashed border-line px-1.5 text-[11px] text-ink-3">{r.name}</span>
                ) : (
                  <span className="opacity-50"><Avatar src={r.avatar} name={r.name ?? r.login} size={20} /></span>
                )}
              </Tip>
            ))}
          </dd>
        </>
      )}

      {unresolved > 0 && (
        <>
          <dt className="text-ink-3">Threads</dt>
          <dd className="flex items-center gap-1.5 text-ink-2"><MessageSquare size={13} className="text-ink-3" /> {unresolved} unresolved</dd>
        </>
      )}
    </dl>
  );
}

/** GitHub's HTML comments are template scaffolding nobody wrote for a reader. */
const readable = (body: string) => body.replace(/<!--[\s\S]*?-->/g, "").trim();

function Description({ body, expanded, onExpand }: { body: string; expanded: boolean; onExpand: () => void }) {
  const text = readable(body);
  if (!text) return <p className="mt-6 text-[13px] text-ink-3">No description.</p>;
  const long = text.length > BODY_FOLDED_CHARS;
  return (
    <section className="mt-6">
      <div className={`relative text-[13.5px] leading-[1.6] text-ink-2 ${long && !expanded ? "max-h-64 overflow-hidden" : ""}`}>
        <Markdown text={text} />
        {long && !expanded && <div className="pointer-events-none absolute inset-x-0 bottom-0 h-16 bg-gradient-to-t from-page to-transparent" />}
      </div>
      {long && !expanded && (
        <button type="button" onClick={onExpand} className="press mt-1 rounded-md px-1.5 py-0.5 text-[12.5px] text-ink-3 hover:bg-pane hover:text-ink">
          Show all
        </button>
      )}
    </section>
  );
}

const CHANGE_ICON = { added: FilePlus, deleted: FileMinus } as const;

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** The code a reviewer should look at first. Tests, docs and generated files are a count, not a list. */
function Files({ detail, files, url }: { detail: PrDetail; files: Reviewable; url: string }) {
  const shown = files.code.slice(0, FILES_SHOWN);
  const { test, docs, generated } = files.others;
  const rest = [files.code.length > shown.length && plural(files.code.length - shown.length, "more code file"), test && plural(test, "test"), docs && plural(docs, "doc"), generated && `${generated} generated`].filter(Boolean);
  const unlisted = detail.changedFiles - detail.files.length;
  if (shown.length === 0 && rest.length === 0) return null;
  return (
    <section className="mt-6">
      {shown.length > 0 && (
        <>
          <h3 className="mb-1.5 text-[12.5px] font-medium text-ink-3">Biggest code changes</h3>
          <ul className="space-y-0.5">
            {shown.map((f) => {
              const Icon = f.change === "added" || f.change === "deleted" ? CHANGE_ICON[f.change] : FileText;
              const slash = f.path.lastIndexOf("/");
              return (
                <li key={f.path} className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 py-0.5 font-mono text-[11.5px]">
                  <Tip label={f.change}>
                    <Icon size={12} className="text-ink-4" />
                  </Tip>
                  <span className="truncate text-ink-2" title={f.path}>
                    <span className="text-ink-4">{f.path.slice(0, slash + 1)}</span>
                    {f.path.slice(slash + 1)}
                  </span>
                  <span className="text-ink-4">
                    <span className="text-add/80">+{f.additions}</span> <span className="text-del/80">−{f.deletions}</span>
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      )}
      {(rest.length > 0 || unlisted > 0) && (
        <a href={`${url}/files`} target="_blank" rel="noreferrer" className="press mt-1.5 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] text-ink-3 hover:bg-pane hover:text-ink">
          {shown.length === 0 ? "Only " : "Also "}
          {[...rest, unlisted > 0 && `${unlisted} more files`].filter(Boolean).join(", ")}
          <ArrowUpRight size={12} className="opacity-60" />
        </a>
      )}
    </section>
  );
}

function PreviewSkeleton() {
  return (
    <div className="mt-5 space-y-3" aria-busy>
      <div className="h-24 rounded-xl bg-pane" />
      {[90, 76, 84, 58].map((w, i) => (
        <div key={i} className="h-3.5 rounded bg-pane" style={{ width: `${w}%` }} />
      ))}
    </div>
  );
}
