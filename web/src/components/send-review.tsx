// The last step of a review: what you and the agent agreed on, worded for the
// PR author, shown exactly as it will be sent. Nothing leaves until Send.
import { useEffect, useMemo, useState } from "react";
import { Check, Copy, ExternalLink, X } from "lucide-react";
import { action } from "../lib/api.ts";
import { useReview } from "../lib/review.tsx";
import { Markdown } from "./markdown.tsx";

type Event = "COMMENT" | "APPROVE" | "REQUEST_CHANGES";
type Draft = {
  event: Event;
  body: string;
  markdown: string;
  target: { pr: number; repo: string | null } | null;
  comments: { noteId: string; number: number; path: string; line: number; startLine: number | null; body: string; inline: boolean }[];
};

const EVENTS: [Event, string][] = [
  ["COMMENT", "Comment"],
  ["APPROVE", "Approve"],
  ["REQUEST_CHANGES", "Request changes"],
];

export function SendReview({ onClose }: { onClose: () => void }) {
  const { state, openNote } = useReview();
  const review = state?.review;
  const [event, setEvent] = useState<Event | null>(null);
  const [body, setBody] = useState(review?.outgoingBody ?? "");
  const [draft, setDraft] = useState<Draft | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirming, setConfirming] = useState(false);

  // Re-draft whenever the review changes underneath (the agent may be rewording comments right now).
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => {
      action<Draft>("review.draft", { ...(event ? { event } : {}), ...(body.trim() ? { body } : {}) })
        .then((d) => live && (setDraft(d), setError(null)))
        .catch((e: Error) => live && setError(e.message));
    }, 150);
    return () => {
      live = false;
      clearTimeout(t);
    };
  }, [state, event, body]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const effective = event ?? draft?.event ?? "COMMENT";
  const inline = useMemo(() => draft?.comments.filter((c) => c.inline) ?? [], [draft]);
  const folded = useMemo(() => draft?.comments.filter((c) => !c.inline) ?? [], [draft]);
  const canSend = !!draft?.target?.repo && !review?.published;

  const send = async () => {
    setBusy(true);
    setError(null);
    try {
      await action("review.update", { outgoingBody: body });
      await action("review.publish", { event: effective, ...(body.trim() ? { body } : {}) });
      setConfirming(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 flex justify-end bg-page/60 backdrop-blur-[2px]" onPointerDown={(e) => e.target === e.currentTarget && onClose()}>
      <aside className="fade-in flex h-full w-full max-w-[36rem] flex-col border-l border-line bg-pane" aria-label="Send review">
        <header className="flex items-start gap-3 border-b border-line-subtle px-5 py-4">
          <div className="min-w-0 flex-1">
            <h2 className="text-[15px] font-medium text-ink">Send review</h2>
            <p className="mt-0.5 font-mono text-2xs text-ink-3">
              {draft?.target ? `${draft.target.repo ?? "unknown repo"} · #${draft.target.pr}` : "Not a pull request review: copy it as markdown instead."}
            </p>
          </div>
          <button type="button" onClick={onClose} className="press rounded-md p-1.5 text-ink-3 hover:bg-overlay hover:text-ink" aria-label="Close">
            <X size={15} />
          </button>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4">
          {review?.published && (
            <a href={review.published.url} target="_blank" rel="noreferrer" className="mb-4 flex items-center gap-2 rounded-md border border-line px-3 py-2.5 text-[13px] text-ink hover:bg-overlay">
              <Check size={14} /> Sent as {review.published.event.toLowerCase().replace("_", " ")} with {review.published.comments} inline comments
              <ExternalLink size={13} className="ml-auto text-ink-3" />
            </a>
          )}

          <fieldset>
            <legend className="eyebrow pb-1.5">Verdict</legend>
            <div className="flex rounded-md border border-line-subtle p-0.5">
              {EVENTS.map(([e, label]) => (
                <button key={e} type="button" onClick={() => (setEvent(e), void action("review.verdict", { value: e === "APPROVE" ? "approve" : e === "REQUEST_CHANGES" ? "changes" : "comment" }))} aria-pressed={effective === e} className={`press flex-1 rounded-[4px] px-2 py-1 text-[12.5px] ${effective === e ? "bg-overlay text-ink" : "text-ink-3 hover:text-ink-2"}`}>
                  {label}
                </button>
              ))}
            </div>
          </fieldset>

          <label htmlFor="outgoing-body" className="eyebrow mt-5 block pb-1.5">
            To the author
          </label>
          <textarea
            id="outgoing-body"
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onBlur={() => body !== (review?.outgoingBody ?? "") && void action("review.update", { outgoingBody: body })}
            rows={5}
            placeholder={draft?.body ?? "What this change does, and what must change before it merges."}
            className="block w-full resize-y rounded-md border border-line bg-page px-3 py-2.5 text-[13px] leading-5 text-ink placeholder:text-ink-4 focus:border-ink-4 focus:outline-none"
          />
          <p className="mt-1 text-[11.5px] text-ink-3">Empty uses the agent's draft above. Your conversation with the agent is never sent.</p>

          <h3 className="eyebrow mt-6 flex pb-1.5">
            Inline comments <span className="ml-auto font-mono normal-case tracking-normal text-ink-4">{inline.length}</span>
          </h3>
          {inline.length === 0 && <p className="text-[12.5px] text-ink-3">None. Mark threads with “Send to the PR author”.</p>}
          <ul className="space-y-2">
            {[...inline, ...folded].map((c) => (
              <li key={c.noteId} className="rounded-md border border-line-subtle">
                <div className="flex items-center gap-2 border-b border-line-subtle px-2.5 py-1.5">
                  <button type="button" onClick={() => (onClose(), openNote(c.noteId))} className="press font-mono text-2xs text-ink-2 hover:text-ink" title="Open the thread">
                    #{c.number}
                  </button>
                  <span className="truncate font-mono text-2xs text-ink-3">
                    {c.path}:{c.startLine ? `${c.startLine}–` : ""}
                    {c.line}
                  </span>
                  {!c.inline && <span className="font-mono text-2xs text-ink-3" title="GitHub only takes inline comments on lines in the diff; this one goes into the review body">in body</span>}
                  <button
                    type="button"
                    onClick={() => void action("note.update", { noteId: c.noteId, outgoing: { include: false, body: "" } })}
                    className="press ml-auto rounded p-0.5 text-ink-4 hover:text-ink-2"
                    title="Keep this one private"
                  >
                    <X size={12} />
                  </button>
                </div>
                <div className="max-h-48 overflow-y-auto px-2.5 py-2">
                  <Markdown text={c.body} className="prose-ds text-[12.5px]" />
                </div>
              </li>
            ))}
          </ul>
          {error && <p className="mt-4 text-[12.5px] text-del">{error}</p>}
        </div>

        <footer className="border-t border-line-subtle px-5 py-3.5">
          {confirming ? (
            <div className="flex items-center gap-2">
              <p className="flex-1 text-[12.5px] text-ink-2">
                Post to <span className="font-mono text-ink">#{draft?.target?.pr}</span> as {EVENTS.find(([e]) => e === effective)?.[1].toLowerCase()} with {inline.length} inline comments? This is public and can't be unsent.
              </p>
              <button type="button" onClick={() => setConfirming(false)} className="press rounded-md px-2.5 py-1.5 text-[12.5px] text-ink-3 hover:bg-overlay">
                Back
              </button>
              <button type="button" disabled={busy} onClick={() => void send()} className="press rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-page hover:bg-white disabled:opacity-40">
                {busy ? "Sending…" : "Send"}
              </button>
            </div>
          ) : (
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => draft && void navigator.clipboard.writeText(draft.markdown).then(() => (setCopied(true), setTimeout(() => setCopied(false), 1500)))}
                className="press flex items-center gap-1.5 rounded-md border border-line px-2.5 py-1.5 text-[12.5px] text-ink-2 hover:bg-overlay"
              >
                {copied ? <Check size={13} /> : <Copy size={13} />} {copied ? "Copied" : "Copy markdown"}
              </button>
              <button type="button" onClick={() => void action("review.done").then(onClose)} className="press rounded-md px-2.5 py-1.5 text-[12.5px] text-ink-3 hover:bg-overlay hover:text-ink-2" title="Releases a waiting agent">
                End session
              </button>
              <button
                type="button"
                disabled={!canSend}
                onClick={() => setConfirming(true)}
                className="press ml-auto rounded-md bg-ink px-3 py-1.5 text-[12.5px] font-medium text-page hover:bg-white disabled:opacity-30"
                title={canSend ? "Review what gets posted, then confirm" : review?.published ? "Already sent" : "Only pull request reviews can be sent"}
              >
                Send to #{draft?.target?.pr ?? "PR"}…
              </button>
            </div>
          )}
        </footer>
      </aside>
    </div>
  );
}
