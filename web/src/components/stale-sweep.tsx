// Pull requests nobody has touched in two weeks, gone through one at a time.
// Each needs a decision, not a slot: every choice names exactly what it does on
// GitHub and here, none is the default, and Skip leaves it for next time.
import { useEffect, useRef, useState } from "react";
import { X } from "lucide-react";
import { staleChoices, type Item, type StaleChoice } from "@domain/inbox.ts";
import { fetchPrDetail, homeAction } from "../lib/api.ts";
import { navigate } from "../lib/route.ts";
import { Avatar, PrLink } from "./pull-request.tsx";

export function StaleCard({ count, onOpen }: { count: number; onOpen: () => void }) {
  return (
    <section className="mt-10 flex items-center gap-3 rounded-xl border border-line-subtle px-4 py-3">
      <p className="flex-1 text-[13px] text-ink-2">
        {count} pull request{count === 1 ? "" : "s"} quiet for over 2 weeks
      </p>
      <button type="button" onClick={onOpen} className="press rounded-lg border border-line px-3 py-1.5 text-[13px] text-ink hover:bg-pane">
        Go through them
      </button>
    </section>
  );
}

/** "318 days": a sentence wants words, not the row's "318d". */
function howLong(iso: string): string {
  const hours = Math.max(1, Math.round((Date.now() - Date.parse(iso)) / 3_600_000));
  return hours < 48 ? `${hours} hour${hours === 1 ? "" : "s"}` : `${Math.round(hours / 24)} days`;
}
const longAgo = (iso: string) => `${howLong(iso)} ago`;

/** What happened last, from facts the inbox already has. */
function lastHappened(item: Item): string {
  const pr = item.lead;
  const who = `@${pr.author}`;
  if (pr.role === "author") return `Your PR. Nothing has happened in ${howLong(pr.updatedAt)}.`;
  if (item.move.kind === "rereview") {
    const { how, at } = item.move.because;
    if (how === "re-requested") return `${who} asked for your review again ${longAgo(at)}. Nothing since.`;
    return `${who} ${how} ${longAgo(at)}, after your review. Nothing since.`;
  }
  if (pr.myReviewAt) return `You reviewed ${longAgo(pr.myReviewAt)}. ${who} hasn't pushed or replied since.`;
  if (pr.reviewRequested) return `${who} asked for your review. Nothing has happened in ${howLong(pr.updatedAt)}.`;
  return `Nothing has happened in ${howLong(pr.updatedAt)}.`;
}

type Shown = { key: string; label: string; effect: string };
const HERE_HIDDEN = "Here: hidden until someone pushes or comments.";

function shown(choice: StaleChoice, item: Item): Shown {
  const who = `@${item.lead.author}`;
  switch (choice.kind) {
    case "remove-request":
      return { key: "r", label: "Remove me as reviewer", effect: `GitHub: deletes your review request. ${HERE_HIDDEN}` };
    case "comment":
      return {
        key: "m",
        label: choice.to === "author" ? `Comment asking ${who} if it's still going` : "Comment asking reviewers to look",
        effect: `GitHub: posts the comment you write next, when you press Post. ${HERE_HIDDEN}`,
      };
    case "close":
      return { key: "c", label: "Close this PR", effect: "GitHub: closes it, with the reason you write next as a comment. The branch stays." };
    case "hide": {
      const unless = item.lead.role === "author" ? "someone pushes or comments on it" : `${who} pushes or comments`;
      return choice.nextMove === "yours"
        ? { key: "h", label: `Hide (it won't come back unless ${unless})`, effect: "GitHub: nothing." }
        : { key: "h", label: "Hide until someone pushes or comments", effect: "GitHub: nothing." };
    }
    case "ask-agent":
      return { key: "a", label: "Have Claude read the thread and suggest", effect: "Starts the agent on it. It posts nothing." };
  }
}

type Writing = { kind: "comment"; body: string } | { kind: "close"; body: string };

export function StaleSweep({ items, onClose }: { items: Item[]; onClose: () => void }) {
  // The list refreshes as you decide and decided PRs leave it; the sweep keeps what it started with.
  const [snapshot] = useState(() => items);
  const [at, setAt] = useState(0);
  const [decided, setDecided] = useState(0);
  const [writing, setWriting] = useState<Writing | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const item = snapshot[at] ?? null;
  const choices = item ? staleChoices(item) : [];

  const next = (counted: boolean) => {
    if (counted) setDecided((d) => d + 1);
    setWriting(null);
    setError(null);
    setAt((i) => i + 1);
  };

  const run = async (decision: { kind: "remove-request" } | { kind: "hide" } | { kind: "comment"; body: string } | { kind: "close"; reason: string }) => {
    if (!item) return;
    setBusy(true);
    setError(null);
    try {
      await homeAction("stale.decide", { key: item.key, decision });
      next(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const startWriting = async (choice: StaleChoice) => {
    if (!item) return;
    if (choice.kind === "close") return setWriting({ kind: "close", body: "" });
    if (choice.kind !== "comment") return;
    if (choice.to === "author") return setWriting({ kind: "comment", body: `@${item.lead.author} is this still going? Happy to take another look when it's ready.` });
    setWriting({ kind: "comment", body: "Could someone take a look?" });
    const detail = await fetchPrDetail(item.lead.repo, item.lead.number).catch(() => null);
    const people = (detail?.requested ?? []).flatMap((r) => (r.kind === "person" ? [`@${r.login}`] : []));
    if (people.length) setWriting((w) => (w?.kind === "comment" && w.body === "Could someone take a look?" ? { kind: "comment", body: `${people.join(" ")} could one of you take a look?` } : w));
  };

  const pick = (choice: StaleChoice) => {
    if (!item || busy) return;
    switch (choice.kind) {
      case "remove-request":
        return void run({ kind: "remove-request" });
      case "hide":
        return void run({ kind: "hide" });
      case "comment":
      case "close":
        return void startWriting(choice);
      case "ask-agent":
        return void homeAction<{ path: string } | { url: string }>("stale.ask", { key: item.key })
          .then((where) => ("url" in where ? window.open(where.url, "_blank", "noreferrer") : navigate(where.path)))
          .catch((e: Error) => setError(e.message));
    }
  };

  const post = () => {
    if (!writing || !writing.body.trim()) return;
    void run(writing.kind === "comment" ? { kind: "comment", body: writing.body } : { kind: "close", reason: writing.body });
  };

  useEffect(() => {
    if (writing) textRef.current?.focus();
  }, [writing?.kind]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") return writing ? setWriting(null) : onClose();
      if (writing) {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) post();
        return;
      }
      if (e.metaKey || e.ctrlKey || e.altKey || !item) return;
      if (e.key === "j") return next(false);
      const choice = choices.find((c) => shown(c, item).key === e.key);
      if (choice) {
        e.preventDefault();
        pick(choice);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  return (
    <div className="fixed inset-0 z-30 flex justify-end bg-page/60 backdrop-blur-[2px]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside aria-label="Stale pull requests" className="slide-in-right flex h-full w-full flex-col border-l border-line-subtle bg-page shadow-[-24px_0_48px_rgb(0_0_0/0.35)] md:w-[32rem]">
        <header className="flex items-center gap-2 px-5 pb-2 pt-4 text-[12.5px] text-ink-3">
          <span className="flex-1">{item ? `${at + 1} of ${snapshot.length} quiet for over 2 weeks` : "Quiet for over 2 weeks"}</span>
          <button type="button" onClick={onClose} aria-label="Close (esc)" title="Close (esc)" className="press grid size-7 place-items-center rounded-md text-ink-3 hover:bg-overlay hover:text-ink">
            <X size={15} />
          </button>
        </header>

        {!item ? (
          <div className="px-5 pt-6">
            <p className="text-[15px] font-medium text-ink">
              Done. {decided} decided{snapshot.length - decided ? `, ${snapshot.length - decided} skipped` : ""}.
            </p>
            <button type="button" onClick={onClose} className="press mt-4 rounded-lg bg-ink px-4 py-2 text-[14px] font-medium text-page hover:bg-white">
              Close
            </button>
          </div>
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto px-5 pb-6">
            <h2 className="text-[19px] font-semibold leading-snug tracking-[-0.01em] text-ink">{item.lead.title}</h2>
            <div className="mt-2 flex items-center gap-2 text-[12.5px] text-ink-3">
              <Avatar src={item.lead.authorAvatar} name={item.lead.authorName ?? item.lead.author} size={16} />
              <span>{item.lead.role === "author" ? "You" : (item.lead.authorName ?? item.lead.author)}</span>
              <span className="text-ink-4">·</span>
              <PrLink item={item} />
            </div>
            <p className="mt-4 text-[13.5px] text-ink-2">{lastHappened(item)}</p>

            {writing ? (
              <div className="mt-6">
                <label htmlFor="stale-text" className="eyebrow block pb-1.5">
                  {writing.kind === "comment" ? "Comment, posted on the PR" : "Why you're closing it, posted as a comment"}
                </label>
                <textarea
                  id="stale-text"
                  ref={textRef}
                  rows={4}
                  value={writing.body}
                  onChange={(e) => setWriting({ ...writing, body: e.target.value })}
                  placeholder={writing.kind === "close" ? "Superseded by #123" : undefined}
                  className="block w-full resize-y rounded-md border border-line bg-pane px-3 py-2.5 text-[13px] leading-5 text-ink placeholder:text-ink-4 focus:border-ink-4 focus:outline-none"
                />
                <div className="mt-3 flex items-center gap-2">
                  <button type="button" disabled={busy || !writing.body.trim()} onClick={post} className="press rounded-lg bg-ink px-4 py-2 text-[13.5px] font-medium text-page hover:bg-white disabled:opacity-40">
                    {busy ? "Posting…" : writing.kind === "comment" ? "Post comment" : "Close PR and post"}
                  </button>
                  <button type="button" onClick={() => setWriting(null)} className="press rounded-lg px-3 py-2 text-[13px] text-ink-3 hover:bg-pane">
                    Back
                  </button>
                  <span className="ml-auto font-mono text-2xs text-ink-4">
                    <span className="kbd">⌘↵</span> post · <span className="kbd">esc</span> back
                  </span>
                </div>
              </div>
            ) : (
              <ul className="mt-6 space-y-1.5">
                {choices.map((choice) => {
                  const s = shown(choice, item);
                  return (
                    <li key={choice.kind}>
                      <button type="button" disabled={busy} onClick={() => pick(choice)} className="press grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-baseline gap-2 rounded-lg border border-line-subtle px-3 py-2.5 text-left hover:bg-pane disabled:opacity-50">
                        <span className="kbd justify-self-start">{s.key}</span>
                        <span>
                          <span className="block text-[13.5px] text-ink">{s.label}</span>
                          <span className="block text-[12px] text-ink-3">{s.effect}</span>
                        </span>
                      </button>
                    </li>
                  );
                })}
                <li>
                  <button type="button" onClick={() => next(false)} className="press grid w-full grid-cols-[1.5rem_minmax(0,1fr)] items-baseline gap-2 rounded-lg px-3 py-2.5 text-left hover:bg-pane">
                    <span className="kbd justify-self-start">j</span>
                    <span>
                      <span className="block text-[13.5px] text-ink-2">Skip</span>
                      <span className="block text-[12px] text-ink-3">Stays in this list for next time.</span>
                    </span>
                  </button>
                </li>
              </ul>
            )}
            {error && <p className="mt-4 text-[12.5px] text-del">{error}</p>}
          </div>
        )}
      </aside>
    </div>
  );
}
